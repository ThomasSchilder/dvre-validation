import { Wallet, ContractFactory, Contract, Interface } from "ethers";
import fs from "fs";
import { loadConfig, RoundRobinProvider, saveResults, sleep } from "./helpers.js";

function loadAbi(name) {
  const path = new URL(`./abi/${name}.json`, import.meta.url).pathname;
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

async function deployContract(signer, abi, bytecode, ...args) {
  const factory = new ContractFactory(abi, bytecode, signer);
  const contract = await factory.deploy(...args);
  await contract.waitForDeployment();
  return contract;
}

const SENDER_WALLET_COUNT = 20;

async function main() {
  const cfg = loadConfig();
  const rr = new RoundRobinProvider(cfg.rpcUrls);

  console.log(`Connected to ${rr.count} RPC node(s)`);
  console.log(`Chain ID: ${cfg.chainId}`);

  const deployKey = process.env.DEPLOYER_PRIVATE_KEY || Wallet.createRandom().privateKey;

  const deployer = new Wallet(deployKey, rr.next());
  console.log(`Deployer: ${deployer.address}`);

  const results = [];

  const assetAbi = loadAbi("AssetV1");
  const amAbi = loadAbi("AMContract");
  const policyAbi = loadAbi("ResearcherPolicy");

  console.log("\n--- Deploying contracts ---");

  const t0 = Date.now();
  const assetV1 = await deployContract(deployer, assetAbi.abi, assetAbi.bytecode);
  const t1 = Date.now();
  const assetV1Addr = await assetV1.getAddress();
  console.log(`AssetV1 deployed: ${assetV1Addr} (${t1 - t0}ms)`);
  results.push({
    step: "deploy_assetv1",
    address: assetV1Addr,
    latency_ms: t1 - t0,
    ts: t0,
  });

  const amContract = await deployContract(deployer, amAbi.abi, amAbi.bytecode);
  const t2 = Date.now();
  const amAddr = await amContract.getAddress();
  console.log(`AMContract deployed: ${amAddr} (${t2 - t1}ms)`);
  results.push({
    step: "deploy_amcontract",
    address: amAddr,
    latency_ms: t2 - t1,
    ts: t1,
  });

  const policy = await deployContract(deployer, policyAbi.abi, policyAbi.bytecode, amAddr);
  const t3 = Date.now();
  const policyAddr = await policy.getAddress();
  console.log(`ResearcherPolicy deployed: ${policyAddr} (${t3 - t2}ms)`);
  results.push({
    step: "deploy_researcherpolicy",
    address: policyAddr,
    latency_ms: t3 - t2,
    ts: t2,
  });

  console.log("\n--- Setting up state ---");

  const researcherWallet = Wallet.createRandom();
  console.log(`Researcher wallet: ${researcherWallet.address}`);

  const amWithDeployer = amContract.connect(deployer);
  const tx1 = await amWithDeployer.setAttribute(researcherWallet.address, "role", "researcher");
  const receipt1 = await tx1.wait();
  const t4 = Date.now();
  console.log(`setAttribute(role=researcher) confirmed in block ${receipt1.blockNumber}`);
  results.push({
    step: "set_attribute_researcher",
    tx_hash: tx1.hash,
    block_number: receipt1.blockNumber,
    latency_ms: t4 - t3,
    ts: t3,
  });

  const assetWithDeployer = assetV1.connect(deployer);
  const tx2 = await assetWithDeployer.createAsset("operator", "http://operator", 0, 0, "{}");
  const receipt2 = await tx2.wait();
  const t5 = Date.now();
  console.log(`createAsset (operator, ID 1) confirmed in block ${receipt2.blockNumber}`);
  results.push({
    step: "create_asset_operator",
    tx_hash: tx2.hash,
    block_number: receipt2.blockNumber,
    latency_ms: t5 - t4,
    ts: t4,
  });

  const tx3 = await assetWithDeployer.setPolicyAddress(1, policyAddr);
  const receipt3 = await tx3.wait();
  const t6 = Date.now();
  console.log(`setPolicyAddress(1, ${policyAddr}) confirmed in block ${receipt3.blockNumber}`);
  results.push({
    step: "set_policy_address",
    tx_hash: tx3.hash,
    block_number: receipt3.blockNumber,
    latency_ms: t6 - t5,
    ts: t5,
  });

  console.log(`\n--- Generating ${SENDER_WALLET_COUNT} sender wallets ---`);
  const senderWallets = [];
  for (let i = 0; i < SENDER_WALLET_COUNT; i++) {
    senderWallets.push(Wallet.createRandom());
  }
  console.log(`${SENDER_WALLET_COUNT} wallets generated`);

  console.log(`\n--- Each wallet deploys own AMContract (parallel) ---`);
  const amDeployPromises = senderWallets.map((w) => {
    const signer = new Wallet(w.privateKey, rr.next());
    return deployContract(signer, amAbi.abi, amAbi.bytecode);
  });
  const amContracts = await Promise.all(amDeployPromises);
  const senderAmAddresses = await Promise.all(amContracts.map((c) => c.getAddress()));
  console.log(`${SENDER_WALLET_COUNT} AMContracts deployed`);

  console.log(`\n--- Each wallet creates own asset in AssetV1 (parallel) ---`);
  const assetIface = new Interface(assetAbi.abi);
  const assetCreatePromises = senderWallets.map((w, i) => {
    const signer = new Wallet(w.privateKey, rr.next());
    const contract = new Contract(assetV1Addr, assetAbi.abi, signer);
    return contract.createAsset(`sender-asset-${i}`, "http://example.com", 0, 0, "{}").then((tx) => tx.wait());
  });
  const assetReceipts = await Promise.all(assetCreatePromises);

  const senderAssetIds = assetReceipts.map((receipt, i) => {
    for (const log of receipt.logs) {
      try {
        const parsed = assetIface.parseLog({ topics: [...log.topics], data: log.data });
        if (parsed && parsed.name === "AssetCreated") {
          return Number(parsed.args.assetId);
        }
      } catch {}
    }
    throw new Error(`AssetCreated event not found for wallet ${i}`);
  });
  console.log(`Asset IDs: ${senderAssetIds.join(", ")}`);

  const senderWalletInfo = senderWallets.map((w, i) => ({
    address: w.address,
    privateKey: w.privateKey,
    amContractAddress: senderAmAddresses[i],
    assetId: senderAssetIds[i],
  }));

  console.log("\n--- Verifying setup ---");
  const policyAddr2 = await assetV1.getPolicyAddress(1);
  const role = await amContract.getAttribute(researcherWallet.address, "role");
  const evalResult = await policy.evaluate(researcherWallet.address);
  console.log(`getPolicyAddress(1) = ${policyAddr2}`);
  console.log(`getAttribute(${researcherWallet.address}, "role") = "${role}"`);
  console.log(`evaluate(${researcherWallet.address}) = ${evalResult}`);

  if (!evalResult) {
    console.error("ERROR: evaluate() returned false! Check AMContract address in ResearcherPolicy.");
    process.exit(1);
  }

  const state = {
    assetV1Address: assetV1Addr,
    amContractAddress: amAddr,
    researcherPolicyAddress: policyAddr,
    deployerAddress: deployer.address,
    deployerPrivateKey: deployer.privateKey,
    researcherAddress: researcherWallet.address,
    researcherPrivateKey: researcherWallet.privateKey,
    operatorAssetId: 1,
    senderWallets: senderWalletInfo,
  };

  const statePath = new URL("./results/state.json", import.meta.url);
  fs.writeFileSync(statePath.pathname, JSON.stringify(state, null, 2));
  console.log(`\nState saved to ${statePath.pathname}`);

  saveResults(results, "setup.json");

  console.log("\nSetup complete!");
}

main().catch((err) => {
  console.error("Setup failed:", err);
  process.exit(1);
});
