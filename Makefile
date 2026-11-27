# FairHold developer tasks. Deployment uses Foundry encrypted keystores:
#   cast wallet import aevum-deployer --interactive
#   cast wallet import aevum-mediator --interactive
SHELL := /bin/bash
RPC ?= https://rpc-test.qday.info
ACCOUNT ?= aevum-deployer
MEDIATOR_ACCOUNT ?= aevum-mediator

.PHONY: install build test test-contracts test-mediator abi deploy-aevum setup-mediator local-chain local-deploy mediator web

install:
	cd mediator && npm ci
	cd web && npm ci

build:
	cd contracts && forge build
	node scripts/export-abi.mjs

test: test-contracts test-mediator

test-contracts:
	cd contracts && forge test -vv

test-mediator: build
	cd mediator && npm run typecheck && npm test

abi:
	node scripts/export-abi.mjs

## Deploy MediatedEscrow to Aevum testnet (chain 44005). Legacy txs: Aevum has no EIP-1559.
deploy-aevum:
	cd contracts && forge script script/Deploy.s.sol --rpc-url $(RPC) --account $(ACCOUNT) --broadcast --legacy

## Register the mediator identity and grant the AI service its scoped session key.
setup-mediator:
	cd contracts && ESCROW_ADDRESS=$(ESCROW_ADDRESS) SESSION_KEY=$(SESSION_KEY) \
	  forge script script/SetupMediator.s.sol --rpc-url $(RPC) --account $(MEDIATOR_ACCOUNT) --broadcast --legacy

## Local stack: anvil (Shanghai, like Aevum) + mock tUSD8 + escrow + mediator with session key.
local-chain:
	anvil --hardfork shanghai

local-deploy:
	cd contracts && forge script script/LocalDemo.s.sol --rpc-url http://127.0.0.1:8545 --broadcast --legacy

mediator:
	cd mediator && npm start

web:
	cd web && npm run dev
