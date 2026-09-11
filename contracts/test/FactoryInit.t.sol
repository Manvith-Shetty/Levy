// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Isolates the UserRegistry initialize() step on a Sepolia fork to
/// see what roles actually land on ROOT. Run:
/// forge test --match-contract FactoryInitTest --fork-url $SEPOLIA_RPC_URL -vvv
interface IFactory {
    function deployProxy(address implementation, uint256 salt, bytes memory data)
        external
        returns (address proxy);
}

interface IReg {
    function initialize(address rootAccount, uint256 roleBitmap) external;
    function hasRootRoles(uint256 roleBitmap, address account) external view returns (bool);
    function roles(uint256 resource, address account) external view returns (uint256);
}

contract FactoryInitTest {
    address internal constant FACTORY = 0x10dC6333CDFe1FCEf624c6e0a8221b91804Cd7ef;
    address internal constant USER_REG_IMPL = 0x624a25d67B59D587752EbEc8DdeD8827dAe52050;
    uint256 internal constant ALL_ROLES =
        0x1111111111111111111111111111111111111111111111111111111111111111;

    function testInitGrants() public {
        bytes32 node = keccak256(abi.encode(bytes32(0), keccak256(bytes("root"))));
        uint256 salt = uint256(keccak256(abi.encode(keccak256("UserRegistry"), node, uint256(0))));
        address proxy = IFactory(FACTORY).deployProxy(
            USER_REG_IMPL, salt, abi.encodeCall(IReg.initialize, (address(this), ALL_ROLES))
        );
        uint256 stored = IReg(proxy).roles(0, address(this));
        require(stored == ALL_ROLES, "ROOT bitmap mismatch");
        require(
            IReg(proxy).hasRootRoles((uint256(1) << 0) << 128, address(this)),
            "REGISTRAR_ADMIN missing"
        );
        require(
            IReg(proxy).hasRootRoles((uint256(1) << 16) << 128, address(this)),
            "RENEW_ADMIN missing"
        );
    }
}
