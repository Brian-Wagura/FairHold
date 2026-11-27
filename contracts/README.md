# FairHold contracts

`MediatedEscrow` (inherits `MediatorRegistry`) holds tUSD8 escrows and resolves them by mutual agreement, a bounded mediator proposal, or permissionless deadline fallbacks. See the [root README](../README.md) for the API and [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md) for invariants.

Aevum runs **Shanghai** (no MCOPY/TSTORE), so `foundry.toml` pins `evm_version = "shanghai"` and transactions must be sent with `--legacy`. OpenZeppelin 5.7's EIP712 stack uses MCOPY, so the test token implements `permit` by hand.

```bash
forge build
```

```bash
forge test
```

```bash
forge script script/Deploy.s.sol --rpc-url https://rpc-test.qday.info --account aevum-deployer --broadcast --legacy
```
