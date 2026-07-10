import { Contract } from "ethers";
import fs from "fs";
import { loadConfig, RoundRobinProvider, saveResults, runConcurrent } from "./helpers.js";

function loadAbi(name) {
  const path = new URL(`./abi/${name}.json`, import.meta.url).pathname;
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

async function main() {
  const cfg = loadConfig();
  const rr = new RoundRobinProvider(cfg.rpcUrls);

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
  const allResults = [];

  console.log(`Network size: ${networkSize}, Rate: ${rate} ops/s, Observations: ${cfg.observations}`);

  const readFns = {
    getPolicyAddress: (provider) => {
      const contract = new Contract(state.assetV1Address, assetAbi.abi, provider);
      return contract.getPolicyAddress(state.operatorAssetId);
    },
    getAttribute: (provider) => {
      const contract = new Contract(state.amContractAddress, amAbi.abi, provider);
      return contract.getAttribute(state.researcherAddress, "role");
    },
    evaluate: (provider) => {
      const contract = new Contract(state.researcherPolicyAddress, policyAbi.abi, provider);
      return contract.evaluate(state.researcherAddress);
    },
  };

  for (const [callType, fn] of Object.entries(readFns)) {
    console.log(`\n--- ${callType} | rate=${rate} ops/s ---`);

    const outcomes = await runConcurrent({
      count: cfg.observations,
      intervalMs,
      label: callType,
      submitFn: (i, submitTs) => {
        const provider = rr.next();
        return fn(provider)
          .then((result) => {
            const completeTs = Date.now();
            return {
              call_type: callType,
              network_size: networkSize,
              rate,
              obs_n: i,
              submit_ts: submitTs,
              complete_ts: completeTs,
              latency_ms: completeTs - submitTs,
              rpc_node: provider._rpcUrl,
              result: String(result),
            };
          })
          .catch((err) => {
            const completeTs = Date.now();
            return {
              call_type: callType,
              network_size: networkSize,
              rate,
              obs_n: i,
              submit_ts: submitTs,
              complete_ts: completeTs,
              latency_ms: completeTs - submitTs,
              rpc_node: provider._rpcUrl,
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
  }

  saveResults(allResults, `reads_n${networkSize}_r${rate}_o${cfg.observations}.json`);
  console.log(`\nReads benchmark complete: ${allResults.length} observations`);
}

main().catch((err) => {
  console.error("Reads benchmark failed:", err);
  process.exit(1);
});
