import { Wallet, Interface } from "ethers";
import fs from "fs";
import { loadConfig, RoundRobinProvider, RoundRobinWsProvider, saveResults, runConcurrent } from "./helpers.js";

function loadAbi(name) {
  const path = new URL(`./abi/${name}.json`, import.meta.url).pathname;
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

async function main() {
  const cfg = loadConfig();
  const httpRr = new RoundRobinProvider(cfg.rpcUrls);

  if (!cfg.wsUrls) {
    throw new Error("WS_URLS env var required for writes (WebSocket receipt subscriptions)");
  }
  const wsRr = new RoundRobinWsProvider(cfg.wsUrls);

  const statePath = new URL("./results/state.json", import.meta.url);
  const state = JSON.parse(fs.readFileSync(statePath.pathname, "utf8"));

  const assetAbi = loadAbi("AssetV1");
  const amAbi = loadAbi("AMContract");
  const policyAbi = loadAbi("ResearcherPolicy");

  const networkSize = parseInt(process.env.NETWORK_SIZE || "0");
  if (!networkSize) throw new Error("NETWORK_SIZE env var required");

  const rate = parseInt(process.env.RATE || "0");
  if (!rate) throw new Error("RATE env var required");

  const intervalMs = 1000 / rate;

  const senderWallets = state.senderWallets;
  if (!senderWallets || senderWallets.length === 0) {
    throw new Error("No sender wallets in state.json. Run setup.js first.");
  }
  const numSenders = senderWallets.length;
  const signers = senderWallets.map((w) => new Wallet(w.privateKey));

  console.log(`Network size: ${networkSize}, Rate: ${rate} ops/s, Observations: ${cfg.observations}`);
  console.log(`HTTP nodes: ${httpRr.count}, WS nodes: ${wsRr.count}`);
  console.log(`Using ${numSenders} sender wallets`);

  const amIface = new Interface(amAbi.abi);
  const assetIface = new Interface(assetAbi.abi);
  const policyIface = new Interface(policyAbi.abi);

  const policyDeployData = policyAbi.bytecode + policyIface.encodeDeploy([state.amContractAddress]).slice(2);
  const amDeployData = amAbi.bytecode;

  const GAS_LIMIT_WRITES = 100000;
  const GAS_LIMIT_DEPLOYS = 500000;

  const writeBuilders = {
    setAttribute: (i, nonce) => {
      const senderIdx = i % numSenders;
      const sw = senderWallets[senderIdx];
      const data = amIface.encodeFunctionData("setAttribute", [sw.address, "role", "researcher"]);
      return {
        tx: { to: sw.amContractAddress, data, nonce, gasLimit: GAS_LIMIT_WRITES, chainId: cfg.chainId, gasPrice: 0 },
        signer: signers[senderIdx],
        extra: { subject: sw.address, sender_idx: senderIdx },
      };
    },

    setPolicyAddress: (i, nonce) => {
      const senderIdx = i % numSenders;
      const sw = senderWallets[senderIdx];
      const data = assetIface.encodeFunctionData("setPolicyAddress", [sw.assetId, state.researcherPolicyAddress]);
      return {
        tx: { to: state.assetV1Address, data, nonce, gasLimit: GAS_LIMIT_WRITES, chainId: cfg.chainId, gasPrice: 0 },
        signer: signers[senderIdx],
        extra: { asset_id: sw.assetId, sender_idx: senderIdx },
      };
    },

    deploy_researcherpolicy: (i, nonce) => {
      const senderIdx = i % numSenders;
      return {
        tx: { data: policyDeployData, nonce, gasLimit: GAS_LIMIT_DEPLOYS, chainId: cfg.chainId, gasPrice: 0 },
        signer: signers[senderIdx],
        extra: { sender_idx: senderIdx },
      };
    },

    deploy_amcontract: (i, nonce) => {
      const senderIdx = i % numSenders;
      return {
        tx: { data: amDeployData, nonce, gasLimit: GAS_LIMIT_DEPLOYS, chainId: cfg.chainId, gasPrice: 0 },
        signer: signers[senderIdx],
        extra: { sender_idx: senderIdx },
      };
    },
  };

  const allResults = [];

  for (const [callType, buildTx] of Object.entries(writeBuilders)) {
    console.log(`\n--- ${callType} | rate=${rate} ops/s ---`);

    const baseNonces = await Promise.all(
      signers.map((s) => httpRr.next().getTransactionCount(s.address, "pending"))
    );
    console.log(`  Base nonces: [${baseNonces.join(", ")}]`);

    /*
     * Pre-sign all transactions before the timed firing loop.
     *
     * ECDSA signing is CPU-bound and takes ~1-5ms per tx on the event loop.
     * If signing happens inside the rate-limited loop, it competes with the
     * cadence timer and causes us to miss the target rate (e.g. at 100 ops/s
     * with 10ms intervals, signing overhead makes us reach only ~80 ops/s).
     *
     * By pre-signing all observations upfront, the hot loop body becomes a
     * pure network I/O call (broadcastTransaction), allowing us to hit the
     * exact target rate. The one-time pre-signing cost is not measured.
     */
    const signStart = Date.now();
    const signedTxs = await Promise.all(
      Array.from({ length: cfg.observations }, (_, i) => {
        const senderIdx = i % numSenders;
        const nonce = baseNonces[senderIdx] + Math.floor(i / numSenders);
        const { tx, signer, extra } = buildTx(i, nonce);
        return signer.signTransaction(tx).then((signedTx) => ({ signedTx, extra, i }));
      })
    );
    console.log(`  Pre-signed ${signedTxs.length} tx in ${Date.now() - signStart}ms`);

    const outcomes = await runConcurrent({
      count: cfg.observations,
      intervalMs,
      label: callType,
      submitFn: (i, submitTs) => {
        const { signedTx, extra } = signedTxs[i];

        return (async () => {
          const broadcastProvider = httpRr.next();
          const txResponse = await broadcastProvider.broadcastTransaction(signedTx);
          const wsProvider = wsRr.next();
          const receipt = await wsProvider.waitForTransaction(txResponse.hash);
          const completeTs = Date.now();
          return {
            call_type: callType,
            network_size: networkSize,
            rate,
            obs_n: i,
            submit_ts: submitTs,
            complete_ts: completeTs,
            latency_ms: completeTs - submitTs,
            block_number: receipt.blockNumber,
            tx_hash: txResponse.hash,
            gas_used: receipt.gasUsed?.toString(),
            rpc_node: broadcastProvider._rpcUrl,
            ws_node: wsRr.urls[wsRr.index % wsRr.count],
            ...extra,
          };
        })().catch((err) => {
          const completeTs = Date.now();
          return {
            call_type: callType,
            network_size: networkSize,
            rate,
            obs_n: i,
            submit_ts: submitTs,
            complete_ts: completeTs,
            latency_ms: completeTs - submitTs,
            error: err.shortMessage || err.message,
          };
        });
      },
    });

    for (const outcome of outcomes) {
      if (outcome.status === "fulfilled") {
        allResults.push(outcome.value);
      } else {
        allResults.push({
          call_type: callType,
          network_size: networkSize,
          rate,
          obs_n: -1,
          error: outcome.reason?.shortMessage || String(outcome.reason),
        });
      }
    }

    console.log(`  Waiting for all sender mempools to drain...`);
    while (true) {
      let allDrained = true;
      for (let s = 0; s < numSenders; s++) {
        const checkProvider = httpRr.next();
        const pending = await checkProvider.getTransactionCount(signers[s].address, "pending");
        const latest = await checkProvider.getTransactionCount(signers[s].address, "latest");
        if (pending !== latest) {
          allDrained = false;
          break;
        }
      }
      if (allDrained) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    console.log(`  All mempools drained.`);
  }

  wsRr.destroy();
  saveResults(allResults, `writes_n${networkSize}_r${rate}_o${cfg.observations}.json`);
  console.log(`\nWrites benchmark complete: ${allResults.length} observations`);
}

main().catch((err) => {
  console.error("Writes benchmark failed:", err);
  process.exit(1);
});
