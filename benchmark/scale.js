import { Wallet, Interface, JsonRpcProvider } from "ethers";
import fs from "fs";
import { loadConfig, RoundRobinProvider, RoundRobinWsProvider, saveResults, withTimeout, sleep } from "./helpers.js";

function loadAbi(name) {
  const path = new URL(`./abi/${name}.json`, import.meta.url).pathname;
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

async function main() {
  const cfg = loadConfig();
  const initialValidators = parseInt(process.env.INITIAL_VALIDATORS || "4");

  const nodesPath = new URL("./nodes.json", import.meta.url);
  const nodes = JSON.parse(fs.readFileSync(nodesPath.pathname, "utf8"));

  const initialHttpUrls = nodes.slice(0, initialValidators).map(n => n.rpc_url);
  const initialWsUrls = initialHttpUrls.map(u => u.replace("http://", "ws://").replace(":8545", ":8546"));
  const httpRr = new RoundRobinProvider(initialHttpUrls);

  if (!cfg.wsUrls) {
    throw new Error("WS_URLS env var required for scale benchmark");
  }
  const wsRr = new RoundRobinWsProvider(initialWsUrls);

  const statePath = new URL("./results/state.json", import.meta.url);
  const state = JSON.parse(fs.readFileSync(statePath.pathname, "utf8"));

  const rate = parseInt(process.env.RATE || "50");
  const intervalMs = 1000 / rate;
  const callType = process.env.CALL_TYPE || "setAttribute";
  const scaleIntervalMs = (cfg.scaleConfig?.intervalSeconds || 60) * 1000;
  const cooldownMs = (cfg.scaleConfig?.cooldownSeconds || 60) * 1000;

  const senderWallets = state.senderWallets;
  if (!senderWallets || senderWallets.length === 0) {
    throw new Error("No sender wallets in state.json. Run setup.js first.");
  }
  const numSenders = senderWallets.length;
  const signers = senderWallets.map((w) => new Wallet(w.privateKey));

  const amAbi = loadAbi("AMContract");
  const amIface = new Interface(amAbi.abi);
  const assetAbi = loadAbi("AssetV1");
  const assetIface = new Interface(assetAbi.abi);
  const policyAbi = loadAbi("ResearcherPolicy");
  const policyIface = new Interface(policyAbi.abi);

  const policyDeployData = policyAbi.bytecode + policyIface.encodeDeploy([state.amContractAddress]).slice(2);
  const amDeployData = amAbi.bytecode;

  const GAS_LIMIT_WRITES = 100000;
  const GAS_LIMIT_DEPLOYS = 500000;

  const validCallTypes = ["setAttribute", "setPolicyAddress", "deploy_researcherpolicy", "deploy_amcontract"];
  if (!validCallTypes.includes(callType)) {
    throw new Error(`Invalid CALL_TYPE: ${callType}. Valid: ${validCallTypes.join(", ")}`);
  }

  function buildTx(i, nonce) {
    const senderIdx = i % numSenders;
    const sw = senderWallets[senderIdx];
    switch (callType) {
      case "setAttribute": {
        const data = amIface.encodeFunctionData("setAttribute", [sw.address, "role", "researcher"]);
        return { tx: { to: sw.amContractAddress, data, nonce, gasLimit: GAS_LIMIT_WRITES, chainId: cfg.chainId, gasPrice: 0 }, signer: signers[senderIdx], senderIdx };
      }
      case "setPolicyAddress": {
        const data = assetIface.encodeFunctionData("setPolicyAddress", [sw.assetId, state.researcherPolicyAddress]);
        return { tx: { to: state.assetV1Address, data, nonce, gasLimit: GAS_LIMIT_WRITES, chainId: cfg.chainId, gasPrice: 0 }, signer: signers[senderIdx], senderIdx };
      }
      case "deploy_researcherpolicy": {
        return { tx: { data: policyDeployData, nonce, gasLimit: GAS_LIMIT_DEPLOYS, chainId: cfg.chainId, gasPrice: 0 }, signer: signers[senderIdx], senderIdx };
      }
      case "deploy_amcontract": {
        return { tx: { data: amDeployData, nonce, gasLimit: GAS_LIMIT_DEPLOYS, chainId: cfg.chainId, gasPrice: 0 }, signer: signers[senderIdx], senderIdx };
      }
    }
  }

  console.log(`Scale benchmark: ${callType} at ${rate} ops/s, ${initialValidators} -> ${nodes.length} validators`);
  console.log(`Scale interval: ${scaleIntervalMs / 1000}s, Cooldown: ${cooldownMs / 1000}s`);
  console.log(`Using ${numSenders} sender wallets, ${httpRr.count} RPC nodes, ${wsRr.count} WS nodes`);

  let nonces = await Promise.all(
    signers.map((s, idx) => httpRr.providers[idx % httpRr.count].getTransactionCount(s.address, "pending"))
  );
  console.log(`Base nonces: [${nonces.join(", ")}]`);

  const transactions = [];
  const scaleEvents = [];
  const txPromises = [];
  let currentValidatorCount = initialValidators;
  let shouldStop = false;
  let txCounter = 0;

  async function getCurrentValidators() {
    const provider = httpRr.next();
    return provider.send("ibft_getValidatorsByBlockNumber", ["latest"]);
  }

  async function getTxPoolStatus() {
    const provider = httpRr.next();
    try {
      return await provider.send("txpool_status", []);
    } catch {
      return { pending: "0x0", queued: "0x0" };
    }
  }

  async function runScaling() {
    const totalSteps = nodes.length - initialValidators;
    console.log(`\n[SCALE] Will add ${totalSteps} validators, one every ${scaleIntervalMs / 1000}s`);

    for (let step = 0; step < totalSteps; step++) {
      await sleep(scaleIntervalMs);

      const nextNode = nodes[initialValidators + step];
      const validatorsBefore = currentValidatorCount;
      const voteSubmitTs = Date.now();

      console.log(`\n[SCALE] Step ${step + 1}/${totalSteps}: Adding validator ${nextNode.address} (node ${initialValidators + step})`);

      for (let v = 0; v < validatorsBefore; v++) {
        const validatorNode = nodes[v];
        try {
          const provider = new JsonRpcProvider(validatorNode.rpc_url);
          await provider.send("ibft_proposeValidatorVote", [nextNode.address, true]);
          console.log(`  Vote submitted from node ${v} (${validatorNode.address})`);
        } catch (err) {
          console.error(`  Vote failed from node ${v}: ${err.shortMessage || err.message}`);
        }
      }

      let activated = false;
      let pollCount = 0;
      let blockNumber = null;
      let activationTs = null;
      let activationDurationMs = null;
      const pollStart = Date.now();
      while (!activated && Date.now() - pollStart < 60000) {
        pollCount++;
        const validators = await getCurrentValidators();
        if (validators.includes(nextNode.address)) {
          activated = true;
          currentValidatorCount = validators.length;
          const provider = httpRr.next();
          blockNumber = await provider.getBlockNumber()
          activationTs = Date.now();
          activationDurationMs = activationTs - voteSubmitTs;
        } else {
          await sleep(500);
        }
      }

      if (!activated) {
        console.error(`[SCALE] Validator ${nextNode.address} failed to activate within 60s!`);
        scaleEvents.push({
          step: step + 1,
          validator_count_before: validatorsBefore,
          validator_count_after: currentValidatorCount,
          node_address: nextNode.address,
          node_index: initialValidators + step,
          vote_submit_ts: voteSubmitTs,
          activation_ts: null,
          activation_duration_ms: null,
          activation_block: null,
          error: "Validator failed to activate within 60s",
        });
        continue;
      }

      scaleEvents.push({
        step: step + 1,
        validator_count_before: validatorsBefore,
        validator_count_after: currentValidatorCount,
        node_address: nextNode.address,
        node_index: initialValidators + step,
        vote_submit_ts: voteSubmitTs,
        activation_ts: activationTs,
        activation_duration_ms: activationDurationMs,
        activation_block: blockNumber,
        poll_count: pollCount,
      });

      console.log(`[SCALE] Validator activated in ${activationDurationMs}ms (polls: ${pollCount}) at block ${blockNumber}`);

      const newNodeHttpUrl = nextNode.rpc_url;
      const newNodeWsUrl = newNodeHttpUrl.replace("http://", "ws://").replace(":8545", ":8546");
      httpRr.addProvider(newNodeHttpUrl);
      wsRr.addProvider(newNodeWsUrl);
      console.log(`[SCALE] Added ${newNodeHttpUrl} to RPC pool (now ${httpRr.count} endpoints)`);
    }

    console.log(`\n[SCALE] All ${nodes.length} validators active. Cooling down for ${cooldownMs / 1000}s...`);
    await sleep(cooldownMs);
    shouldStop = true;
  }

  async function runTxBenchmark() {
    console.log(`\nStarting continuous ${callType} benchmark at ${rate} ops/s`);
    const startMs = Date.now();
    let seconds = 0;

    const logger = setInterval(() => {
      seconds++;
      console.log(`  [benchmark ${seconds}s] sent: ${txCounter}, completed: ${transactions.length}, validators: ${currentValidatorCount}`);
    }, 1000);

    while (!shouldStop) {
      const i = txCounter++;
      const submitTs = Date.now();
      const { tx, signer, senderIdx } = buildTx(i, nonces[i % numSenders]++);
      const signedTx = await signer.signTransaction(tx);

      const httpUrl = httpRr.urls[httpRr.index % httpRr.count];
      const broadcastProvider = httpRr.next();
      const wsUrl = wsRr.urls[wsRr.index % wsRr.count];
      const wsProvider = wsRr.next();

      const promise = withTimeout(
        (async () => {
          const txResponse = await broadcastProvider.broadcastTransaction(signedTx);
          const receipt = await wsProvider.waitForTransaction(txResponse.hash);
          const completeTs = Date.now();
          return {
            call_type: callType,
            obs_n: i,
            submit_ts: submitTs,
            complete_ts: completeTs,
            latency_ms: completeTs - submitTs,
            block_number: receipt.blockNumber,
            tx_hash: txResponse.hash,
            validator_count: currentValidatorCount,
            sender_idx: senderIdx,
            rpc_node: httpUrl,
            ws_node: wsUrl,
          };
        })(),
        120000,
        callType
      ).then((result) => {
        transactions.push(result);
      }).catch(async (err) => {
        try {
          nonces[senderIdx] = await httpRr.next()
            .getTransactionCount(signers[senderIdx].address, "pending");
        } catch {}
        transactions.push({
          call_type: callType,
          obs_n: i,
          submit_ts: submitTs,
          complete_ts: Date.now(),
          latency_ms: Date.now() - submitTs,
          error: err.shortMessage || err.message,
          raw_error: err.error ? JSON.stringify(err.error) : err.toString(),
          validator_count: currentValidatorCount,
          sender_idx: senderIdx,
          signed_tx: signedTx,
        });
      });
      txPromises.push(promise);

      const nextTarget = startMs + (i + 1) * intervalMs;
      const remaining = nextTarget - Date.now();
      if (remaining > 0 && !shouldStop) await sleep(remaining);
    }

    clearInterval(logger);
    console.log(`\nBenchmark loop ended. Sent ${txCounter} tx, waiting for ${txCounter - transactions.length} in-flight...`);
    await Promise.allSettled(txPromises);
    console.log(`All ${transactions.length} transactions completed.`);
  }

  await Promise.all([
    runTxBenchmark(),
    runScaling(),
  ]);

  wsRr.destroy();
  saveResults(transactions, `scale_${callType}_transactions.json`);
  saveResults(scaleEvents, `scale_${callType}_events.json`);

  console.log(`\nScale benchmark complete: ${transactions.length} transactions, ${scaleEvents.length} scaling events`);
}

main().catch((err) => {
  console.error("Scale benchmark failed:", err);
  process.exit(1);
});
