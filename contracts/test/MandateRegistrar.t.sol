// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../src/MandateRegistrar.sol";

/// @notice Minimal cheatcode surface (no forge-std dependency).
interface Vm {
    function warp(uint256) external;
}

/// @notice Shared assertions (no forge-std dependency).
contract MandateAsserts {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function assertEq(uint256 a, uint256 b) internal pure {
        require(a == b, "assertEq(uint256) failed");
    }

    function assertEq(bytes memory a, bytes memory b) internal pure {
        require(keccak256(a) == keccak256(b), "assertEq(bytes) failed");
    }

    function assertTrue(bool c) internal pure {
        require(c, "assertTrue failed");
    }
}

/// @notice Test double for IENSRegistry: scriptable expiry/resolver/status,
/// records the roleBitmap every register() call so tests can assert the
/// non-transferable bitmap.
contract StubRegistry {
    mapping(uint256 => uint64) public expiries;
    mapping(string => address) public resolvers;
    mapping(uint256 => uint8) public statuses; // default 0 = AVAILABLE
    uint256 public lastRoleBitmap;
    uint256 public nextTokenId = 1;

    function setExpiry(uint256 id, uint64 e) external {
        expiries[id] = e;
    }

    function setResolverFor(string calldata label, address r) external {
        resolvers[label] = r;
    }

    function setStatus(uint256 id, uint8 s) external {
        statuses[id] = s;
    }

    function register(
        string calldata,
        address,
        address,
        address,
        uint256 roleBitmap,
        uint64
    ) external returns (uint256 tokenId) {
        lastRoleBitmap = roleBitmap;
        tokenId = nextTokenId++;
    }

    function getStatus(uint256 anyId) external view returns (uint8) {
        return statuses[anyId];
    }

    function getExpiry(uint256 anyId) external view returns (uint64) {
        return expiries[anyId];
    }

    function getResolver(string calldata label) external view returns (address) {
        return resolvers[label];
    }
}

/// @notice Test double for IENSResolver: scriptable text records.
contract StubResolver {
    mapping(bytes32 => mapping(string => string)) private records;

    function setText(bytes32 node, string calldata key, string calldata value) external {
        records[node][key] = value;
    }

    function text(bytes32 node, string calldata key) external view returns (string memory) {
        return records[node][key];
    }
}

contract MandateRegistrarTest is MandateAsserts {
    StubRegistry internal reg;
    StubRegistry internal parentReg;
    StubResolver internal parentResolver;
    MandateRegistrar internal registrar;

    address internal constant OWNER = address(0xA11CE);
    bytes32 internal constant PARENT_NODE = keccak256("parent-node");
    uint64 internal constant NOW = 1_800_000_000;

    function setUp() public {
        vm.warp(NOW);
        reg = new StubRegistry();
        parentReg = new StubRegistry();
        parentResolver = new StubResolver();
        registrar = new MandateRegistrar(IENSRegistry(address(reg)));
    }

    function _bindParent(uint64 parentBudget, uint64 parentExpiry) internal {
        parentReg.setExpiry(uint256(keccak256(bytes("agent"))), parentExpiry);
        parentReg.setResolverFor("agent", address(parentResolver));
        parentResolver.setText(PARENT_NODE, "budget", _toString(parentBudget));
        registrar.bindParent(address(parentReg), "agent", PARENT_NODE);
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

    function testHappyPathMintsInsideParent() public {
        _bindParent(50_000, NOW + 60 days);
        uint256 tokenId = registrar.registerChild(
            address(reg), address(parentReg), "agent", "sub", OWNER, address(parentResolver), 10_000, NOW + 30 days
        );
        assertEq(tokenId, 1);
    }

    function testBitmapOmitsTransferRoles() public {
        _bindParent(50_000, NOW + 60 days);
        registrar.registerChild(
            address(reg), address(parentReg), "agent", "sub", OWNER, address(parentResolver), 10_000, NOW + 30 days
        );
        uint256 bitmap = reg.lastRoleBitmap();
        // ROLE_CAN_TRANSFER_ADMIN would be bit (1<<28)<<128 -- must be absent.
        assertEq(bitmap & ((uint256(1) << 28) << 128), 0);
        // Hierarchy wiring + resolver mgmt must be present.
        assertTrue(bitmap & (uint256(1) << 20) != 0); // SET_SUBREGISTRY
        assertTrue(bitmap & (uint256(1) << 24) != 0); // SET_RESOLVER
    }

    function testRevertWhenBudgetExceedsParent() public {
        _bindParent(50_000, NOW + 60 days);
        try registrar.registerChild(
            address(reg), address(parentReg), "agent", "sub", OWNER, address(parentResolver), 50_001, NOW + 30 days
        ) {
            revert("expected revert");
        } catch (bytes memory err) {
            assertEq(
                err,
                abi.encodeWithSelector(MandateRegistrar.BudgetExceedsParent.selector, 50_001, 50_000)
            );
        }
    }

    function testRevertWhenExpiryExceedsParent() public {
        _bindParent(50_000, NOW + 60 days);
        try registrar.registerChild(
            address(reg), address(parentReg), "agent", "sub", OWNER, address(parentResolver), 10_000, NOW + 61 days
        ) {
            revert("expected revert");
        } catch (bytes memory err) {
            assertEq(
                err,
                abi.encodeWithSelector(
                    MandateRegistrar.ExpiryExceedsParent.selector, NOW + 61 days, NOW + 60 days
                )
            );
        }
    }

    function testRevertWhenParentUnbound() public {
        try registrar.registerChild(
            address(reg), address(parentReg), "agent", "sub", OWNER, address(parentResolver), 10_000, NOW + 30 days
        ) {
            revert("expected revert");
        } catch (bytes memory err) {
            assertEq(err, abi.encodeWithSelector(MandateRegistrar.ParentNotBound.selector));
        }
    }

    function testRevertWhenParentBudgetUnset() public {
        // Parent bound + live, but no budget text seeded -> empty record must fail closed.
        parentReg.setExpiry(uint256(keccak256(bytes("agent"))), NOW + 60 days);
        parentReg.setResolverFor("agent", address(parentResolver));
        registrar.bindParent(address(parentReg), "agent", PARENT_NODE);
        try registrar.registerChild(
            address(reg), address(parentReg), "agent", "sub", OWNER, address(parentResolver), 10_000, NOW + 30 days
        ) {
            revert("expected revert");
        } catch (bytes memory err) {
            assertEq(err, abi.encodeWithSelector(MandateRegistrar.BadBudgetRecord.selector));
        }
    }

    function testRevertWhenParentExpired() public {
        _bindParent(50_000, NOW - 1);
        try registrar.registerChild(
            address(reg), address(parentReg), "agent", "sub", OWNER, address(parentResolver), 10_000, NOW + 30 days
        ) {
            revert("expected revert");
        } catch (bytes memory err) {
            assertEq(err, abi.encodeWithSelector(MandateRegistrar.ParentExpired.selector));
        }
    }

    function testEqualBudgetAndEqualExpiryAreAllowed() public {
        _bindParent(50_000, NOW + 60 days);
        // Boundary is inclusive: child == parent is a strict subset.
        registrar.registerChild(
            address(reg), address(parentReg), "agent", "sub", OWNER, address(parentResolver), 50_000, NOW + 60 days
        );
    }
}
