// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../src/MandateRegistrar.sol";

/// @notice Minimal cheatcode surface for scripting (no forge-std dependency).
interface Vm {
    function envUint(string calldata) external view returns (uint256);
    function addr(uint256) external pure returns (address);
    function startBroadcast(uint256) external;
    function stopBroadcast() external;
}

// Sepolia ENSv2 deployment addresses (docs.ens.domains/learn/deployments#sepolia-ensv2-beta).
address constant FACTORY = 0x10dC6333CDFe1FCEf624c6e0a8221b91804Cd7ef;
address constant USER_REGISTRY_IMPL = 0x624a25d67B59D587752EbEc8DdeD8827dAe52050;
address constant RESOLVER_IMPL = 0x9EAe5C2730a7dD16BDD1DeE6421a1B91e3B0365e;

interface IFactory {
    function deployProxy(address implementation, uint256 salt, bytes memory data)
        external
        returns (address proxy);
}

interface IUserRegistry {
    function initialize(address rootAccount, uint256 roleBitmap) external;
    function grantRootRoles(uint256 roleBitmap, address account) external returns (bool);
    function setSubregistry(uint256 anyId, address subregistry) external;
    function setParent(address parent, string calldata label) external;
}

interface IEnsResolver {
    function initialize(address admin, uint256 roleBitmap, bytes[] calldata setters) external;
    function setText(bytes32 node, string calldata key, string calldata value) external;
    function authorizeTextRoles(bytes calldata toName, string calldata key, address account, bool grant)
        external;
}

/// @notice One-shot deploy + seed for the Leash mandate tree on ENSv2 Sepolia:
/// root -> agent -> sub, each level its own UserRegistry proxy linked by
/// setSubregistry pointers, each name its own PermissionedResolver proxy,
/// budgets/expiries minted strictly inside parents via MandateRegistrar.
///
/// Run: forge script script/DeployMandate.s.sol --rpc-url $SEPOLIA_RPC_URL
///      --private-key $DEPLOYER_KEY --broadcast
contract DeployMandate {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 internal constant ALL_ROLES =
        0x1111111111111111111111111111111111111111111111111111111111111111;
    uint256 internal constant REGISTRAR_RENEW = (uint256(1) << 0) | (uint256(1) << 16);

    function _namehash(bytes32 parent, string memory label) internal pure returns (bytes32) {
        return keccak256(abi.encode(parent, keccak256(bytes(label))));
    }

    function _toString(uint64 v) internal pure returns (string memory) {
        if (v == 0) return "0";
        uint256 len = 0;
        uint64 tmp = v;
        while (tmp > 0) {
            len++;
            tmp /= 10;
        }
        bytes memory out = new bytes(len);
        while (v > 0) {
            out[--len] = bytes1(uint8(48 + (v % 10)));
            v /= 10;
        }
        return string(out);
    }

    function _dns(string memory a, string memory b, string memory c)
        internal
        pure
        returns (bytes memory)
    {
        return
            abi.encodePacked(
                uint8(bytes(a).length), a, uint8(bytes(b).length), b, uint8(bytes(c).length), c, uint8(0)
            );
    }

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_KEY");
        vm.startBroadcast(deployerKey);
        address deployer = vm.addr(deployerKey);

        // --- 1. Three UserRegistry proxies (one per tree level) -------------
        bytes32 rootNode = _namehash(bytes32(0), "root");
        bytes32 agentNode = _namehash(rootNode, "agent");
        bytes32 subNode = _namehash(agentNode, "sub");

        address l1 = IFactory(FACTORY).deployProxy(
            USER_REGISTRY_IMPL,
            uint256(keccak256(abi.encode(keccak256("UserRegistry"), rootNode, uint256(0)))),
            abi.encodeCall(IUserRegistry.initialize, (deployer, ALL_ROLES))
        );
        address l2 = IFactory(FACTORY).deployProxy(
            USER_REGISTRY_IMPL,
            uint256(keccak256(abi.encode(keccak256("UserRegistry"), agentNode, uint256(0)))),
            abi.encodeCall(IUserRegistry.initialize, (deployer, ALL_ROLES))
        );
        address l3 = IFactory(FACTORY).deployProxy(
            USER_REGISTRY_IMPL,
            uint256(keccak256(abi.encode(keccak256("UserRegistry"), subNode, uint256(0)))),
            abi.encodeCall(IUserRegistry.initialize, (deployer, ALL_ROLES))
        );

        // --- 2. Three per-name resolvers (versions disambiguate same admin) --
        address r1 = IFactory(FACTORY).deployProxy(
            RESOLVER_IMPL,
            uint256(keccak256(abi.encode(keccak256("OwnedResolver"), deployer, uint256(0)))),
            abi.encodeCall(IEnsResolver.initialize, (deployer, ALL_ROLES, new bytes[](0)))
        );
        address r2 = IFactory(FACTORY).deployProxy(
            RESOLVER_IMPL,
            uint256(keccak256(abi.encode(keccak256("OwnedResolver"), deployer, uint256(1)))),
            abi.encodeCall(IEnsResolver.initialize, (deployer, ALL_ROLES, new bytes[](0)))
        );
        address r3 = IFactory(FACTORY).deployProxy(
            RESOLVER_IMPL,
            uint256(keccak256(abi.encode(keccak256("OwnedResolver"), deployer, uint256(2)))),
            abi.encodeCall(IEnsResolver.initialize, (deployer, ALL_ROLES, new bytes[](0)))
        );

        // --- 3. Registrar + root roles on every level ------------------------
        MandateRegistrar registrar = new MandateRegistrar(IENSRegistry(l1));
        // NOTE: one registrar per target registry is the secure shape only if
        // parent bindings are fixed; here a single registrar mints into L1/L2/L3
        // via separate bound parents (see bindParent calls below). It needs
        // REGISTRAR+RENEW on each level's ROOT.
        IUserRegistry(l1).grantRootRoles(REGISTRAR_RENEW, address(registrar));
        IUserRegistry(l2).grantRootRoles(REGISTRAR_RENEW, address(registrar));
        IUserRegistry(l3).grantRootRoles(REGISTRAR_RENEW, address(registrar));

        // --- 4. Root (no parent to check against: owner-minted directly) -----
        // The root is minted straight on L1 so its budget is the tree's trust
        // anchor; everything below is subset-checked by the registrar.
        uint64 rootExpiry = uint64(block.timestamp) + 90 days;
        // Same bitmap the registrar grants (SET_SUBREGISTRY+ADMIN, SET_RESOLVER+ADMIN;
        // no transfer roles -> non-transferable). Inlined: public constants are
        // not externally visible on this solc path.
        uint256 rootBitmap = (uint256(1) << 20) |
            ((uint256(1) << 20) << 128) |
            (uint256(1) << 24) |
            ((uint256(1) << 24) << 128);
        IENSRegistry(l1).register(
            "root",
            deployer,
            address(0),
            r1,
            rootBitmap,
            rootExpiry
        );
        IEnsResolver(r1).setText(rootNode, "budget", "100000");
        IEnsResolver(r1).setText(rootNode, "allowedServices", "inference");
        IEnsResolver(r1).setText(rootNode, "ratePerMinute", "100000");
        IEnsResolver(r1).setText(rootNode, "maxPerCall", "100000");

        // --- 5. Agent + sub via the registrar (subset enforcement live) ------
        // NOTE: hierarchy wiring (step 6) must come AFTER minting: setSubregistry
        // requires the name to already exist (empty slot reads as expired).
        registrar.bindParent(l1, "root", rootNode);
        registrar.registerChild(l2, l1, "root", "agent", deployer, r2, 50_000, uint64(block.timestamp) + 60 days);
        IEnsResolver(r2).setText(agentNode, "budget", "50000");
        IEnsResolver(r2).setText(agentNode, "allowedServices", "inference");
        IEnsResolver(r2).setText(agentNode, "ratePerMinute", "50000");
        IEnsResolver(r2).setText(agentNode, "maxPerCall", "50000");

        registrar.bindParent(l2, "agent", agentNode);
        registrar.registerChild(l3, l2, "agent", "sub", deployer, r3, 10_000, uint64(block.timestamp) + 30 days);
        IEnsResolver(r3).setText(subNode, "budget", "10000");
        IEnsResolver(r3).setText(subNode, "allowedServices", "inference");
        IEnsResolver(r3).setText(subNode, "ratePerMinute", "10000");
        IEnsResolver(r3).setText(subNode, "maxPerCall", "5000");

        // --- 6. Hierarchy wiring (needs minted names — see step 5 note) -------
        IUserRegistry(l1).setSubregistry(uint256(keccak256(bytes("root"))), l2);
        IUserRegistry(l2).setSubregistry(uint256(keccak256(bytes("agent"))), l3);
        IUserRegistry(l2).setParent(l1, "root");
        IUserRegistry(l3).setParent(l2, "agent");

        // --- 7. Ops delegation demo: ops may edit ONLY ratePerMinute ---------
        // Pass OPS as --sig ... or edit the constant below before broadcast.
        address ops = deployer;
        IEnsResolver(r3).authorizeTextRoles(_dns("sub", "agent", "root"), "ratePerMinute", ops, true);

        vm.stopBroadcast();
    }
}
