# DVRE Validation

Performance benchmarking of the on-chain access control layer for the DVRE system.

## Quick Start

```bash
# Run full benchmark with 10 Besu validator nodes
make run-test node_count=10 key_name=your-aws-key

# Results are collected in ./results/
```

## Prerequisites

- AWS account with SSH key pair
- Terraform, Ansible, Docker installed locally
- AWS credentials configured

## What It Measures

7 blockchain call types (3 reads, 4 writes) across 5 network sizes (4, 7, 10, 20, 50 validators) at 6 rates (5, 10, 25, 50, 75, 100 ops/s). 1000 observations per condition.
