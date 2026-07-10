# Generate the key files + genesis file
docker run --rm -v "$PWD":/work -w /work hyperledger/besu:25.5.0 \
  operator generate-blockchain-config \
  --config-file=ibftConfigFile.json \
  --to=networkFiles \
  --private-key-file-name=key