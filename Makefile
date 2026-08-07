.PHONY: run-test run-scale-test smoke-write destroy analyze clean

NODE_COUNT ?= 4
KEY_NAME ?= dvre-validation
INITIAL_VALIDATORS ?= 4
CALL_TYPE ?= setAttribute
RATE ?= 10
INVENTORY := ansible/inventory.ini

run-test: infra-up inventory bootstrap deploy-besu run-benchmark collect-results destroy

run-finish:  bootstrap deploy-besu run-benchmark collect-results destroy

run-scale-test: infra-up inventory bootstrap-scale deploy-besu run-scale-benchmark collect-results destroy

run-scale-test-finish: bootstrap-scale deploy-besu run-scale-benchmark collect-results destroy

run-scale-setup-finish: run-scale-benchmark collect-results destroy

infra-up:
	cd terraform && terraform init && terraform apply -auto-approve -var node_count=$(NODE_COUNT) -var key_name=$(KEY_NAME)

inventory:
	@cd terraform && terraform output -json > ../terraform-output.json
	@node -e " \
	const out = require('./terraform-output.json'); \
	const besuIps = out.besu_public_ips.value; \
	const runnerIp = out.runner_public_ip.value; \
	const besuPriv = out.besu_private_ips.value; \
	const runnerPriv = out.runner_private_ip.value; \
	let inv = '[besu]\n'; \
	besuIps.forEach((ip, i) => { \
	  inv += 'besu-' + i + ' ansible_host=' + ip + ' private_ip=' + besuPriv[i] + ' node_index=' + i + '\n'; \
	}); \
	inv += '\n[runner]\n'; \
	inv += 'runner ansible_host=' + runnerIp + ' private_ip=' + runnerPriv + '\n'; \
	inv += '\n[besu:vars]\nansible_user=ubuntu\n\n[runner:vars]\nansible_user=ubuntu\n'; \
	require('fs').writeFileSync('$(INVENTORY)', inv); \
	console.log('Inventory written to $(INVENTORY)');"

bootstrap:
	@echo "Sudo needed to remove root-owned networkFiles/ from previous Besu key generation"
	sudo rm -rf besu/networkFiles
	ansible-playbook ansible/bootstrap.yml -i $(INVENTORY) -e node_count=$(NODE_COUNT) -e validator_count=$(NODE_COUNT)

bootstrap-scale:
	@echo "Sudo needed to remove root-owned networkFiles/ from previous Besu key generation"
	sudo rm -rf besu/networkFiles
	ansible-playbook ansible/bootstrap.yml -i $(INVENTORY) -e node_count=$(NODE_COUNT) -e validator_count=$(INITIAL_VALIDATORS)

deploy-besu:
	ansible-playbook ansible/deploy-besu.yml -i $(INVENTORY)

run-benchmark:
	ansible-playbook ansible/run-benchmark.yml -i $(INVENTORY) -e node_count=$(NODE_COUNT)

smoke-write: infra-up inventory bootstrap deploy-besu
	ansible-playbook ansible/run-benchmark.yml -i $(INVENTORY) -e node_count=$(NODE_COUNT) -e '{"rates":[100]}' -e skip_reads=true

run-scale-benchmark:
	ansible-playbook ansible/run-scale-benchmark.yml -i $(INVENTORY) -e node_count=$(NODE_COUNT) -e initial_validators=$(INITIAL_VALIDATORS) -e call_type=$(CALL_TYPE) -e rate=$(RATE)

collect-results:
	ansible-playbook ansible/collect-results.yml -i $(INVENTORY)

destroy:
	cd terraform && terraform destroy -auto-approve -var node_count=$(NODE_COUNT) -var key_name=$(KEY_NAME)

analyze:
	@echo "Postprocessing is done manually. Results are in ./results/"

clean:
	rm -f $(INVENTORY) terraform-output.json
	rm -rf results/
