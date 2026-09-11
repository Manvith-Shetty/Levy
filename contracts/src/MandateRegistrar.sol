// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Minimal ENSv2 registry interface — only what MandateRegistrar needs.
/// @dev Hand-written (no external deps) against docs.ens.domains/ensv2.
///      `anyId` accepts a labelhash; role bitmap layout follows EAC.
interface IENSRegistry {
    function register(
        string calldata label,
        address owner,
        address registry,
        address resolver,
        uint256 roleBitmap,
        uint64 expiry
    ) external returns (uint256 tokenId);

    function getStatus(uint256 anyId) external view returns (uint8);
    function getExpiry(uint256 anyId) external view returns (uint64);
    function getResolver(string calldata label) external view returns (address);
}

/// @notice Minimal ENSv2 resolver interface (ENSIP-5 text records only).
interface IENSResolver {
    function text(bytes32 node, string calldata key) external view returns (string memory);
}

/// @title MandateRegistrar — recursive, on-chain-enforced agent mandate minting.
/// @notice Mints non-transferable, expiring ENSv2 subnames where every child is
/// a strict on-chain subset of its parent: child.budget <= parent.budget
/// (read live from the parent's resolver text records) and child.expiry <=
/// parent.expiry (read live from the parent registry). Revoking or expiring a
/// parent needs no loop over children: any spend-check resolving up the chain
/// sees the dead parent and halts, because the parent's own entry is gone.
///
/// @dev Parent bindings are owner-set once (`bindParent`): the (parentRegistry,
/// parentLabel) pair maps to the parent namehash whose resolver holds the
/// budget. Binding (not caller-supplied nodes) is what closes the
/// rich-parent/poor-label spoof: callers can never substitute a different
/// parent node at mint time.
contract MandateRegistrar {
    // EAC roles (docs.ens.domains/ensv2): regular nybbles only.
    uint256 private constant ROLE_SET_SUBREGISTRY = 1 << 20;
    uint256 private constant ROLE_SET_SUBREGISTRY_ADMIN = (1 << 20) << 128;
    uint256 private constant ROLE_SET_RESOLVER = 1 << 24;
    uint256 private constant ROLE_SET_RESOLVER_ADMIN = (1 << 24) << 128;

    /// @notice Roles every mandate owner receives: hierarchy wiring + resolver
    /// management. ROLE_CAN_TRANSFER_ADMIN is deliberately OMITTED, which is
    /// what makes every mandate non-transferable (no transfer path exists).
    uint256 public constant MANDATE_ROLE_BITMAP =
        ROLE_SET_SUBREGISTRY |
        ROLE_SET_SUBREGISTRY_ADMIN |
        ROLE_SET_RESOLVER |
        ROLE_SET_RESOLVER_ADMIN;

    uint8 private constant STATUS_AVAILABLE = 0;

    IENSRegistry public immutable REGISTRY;

    address public owner;

    /// parentRegistry => parentLabelhash => parent namehash (0 = unbound).
    mapping(address => mapping(uint256 => bytes32)) public parentNodeFor;

    event ParentBound(address indexed parentRegistry, uint256 indexed parentLabelhash, bytes32 parentNode);
    event MandateRegistered(
        address indexed targetRegistry,
        string label,
        address owner,
        address resolver,
        uint64 expiry,
        uint64 budget,
        uint256 tokenId
    );

    error NotOwner();
    error ParentNotBound();
    error ParentExpired();
    error ParentResolverUnset();
    error BadBudgetRecord();
    error BudgetExceedsParent(uint64 budget, uint64 parentBudget);
    error ExpiryExceedsParent(uint64 expiry, uint64 parentExpiry);
    error ExpiryNotFuture();
    error NameNotAvailable();
    error InvalidOwner();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @param registry Accepted for interface stability but intentionally
    /// unused for authorization: EAC (not this contract) gates where minting
    /// is allowed — registerChild targets any registry explicitly, and only
    /// succeeds where the registry owner granted this contract ROLE_REGISTRAR.
    constructor(IENSRegistry registry) {
        REGISTRY = registry;
        owner = msg.sender;
    }

    /// @notice Binds (parentRegistry, parentLabel) to the parent namehash whose
    /// resolver text records are the source of truth for child budgets.
    function bindParent(address parentRegistry, string calldata parentLabel, bytes32 parentNode)
        external
        onlyOwner
    {
        uint256 labelhash = uint256(keccak256(bytes(parentLabel)));
        parentNodeFor[parentRegistry][labelhash] = parentNode;
        emit ParentBound(parentRegistry, labelhash, parentNode);
    }

    /// @notice Mints a child mandate strictly inside its parent's budget+expiry.
    /// @dev Fails closed on every edge: unbound/expired/unseeded parents,
    /// non-numeric budget records, past expiries, taken labels.
    function registerChild(
        address targetRegistry,
        address parentRegistry,
        string calldata parentLabel,
        string calldata label,
        address nameOwner,
        address resolver,
        uint64 budget,
        uint64 expiry
    ) external returns (uint256 tokenId) {
        uint256 parentLabelhash = uint256(keccak256(bytes(parentLabel)));
        bytes32 parentNode = parentNodeFor[parentRegistry][parentLabelhash];
        if (parentNode == bytes32(0)) revert ParentNotBound();

        uint64 parentExpiry = IENSRegistry(parentRegistry).getExpiry(parentLabelhash);
        if (parentExpiry <= uint64(block.timestamp)) revert ParentExpired();
        if (expiry > parentExpiry) revert ExpiryExceedsParent(expiry, parentExpiry);
        if (expiry <= uint64(block.timestamp)) revert ExpiryNotFuture();
        if (nameOwner == address(0)) revert InvalidOwner();

        address parentResolver = IENSRegistry(parentRegistry).getResolver(parentLabel);
        if (parentResolver == address(0)) revert ParentResolverUnset();
        uint64 parentBudget = _parseBudget(IENSResolver(parentResolver).text(parentNode, "budget"));
        if (budget > parentBudget) revert BudgetExceedsParent(budget, parentBudget);

        if (IENSRegistry(targetRegistry).getStatus(uint256(keccak256(bytes(label)))) != STATUS_AVAILABLE) {
            revert NameNotAvailable();
        }

        tokenId = IENSRegistry(targetRegistry).register(
            label, nameOwner, address(0), resolver, MANDATE_ROLE_BITMAP, expiry
        );
        emit MandateRegistered(targetRegistry, label, nameOwner, resolver, expiry, budget, tokenId);
    }

    /// @notice Strict ASCII uint parser: empty strings, signs, decimals and
    /// non-digits all revert, so an unset/malformed budget record can never
    /// mint an unbounded (or zero-confused) child.
    function _parseBudget(string memory raw) internal pure returns (uint64) {
        bytes memory b = bytes(raw);
        if (b.length == 0 || b.length > 20) revert BadBudgetRecord();
        uint64 out = 0;
        for (uint256 i = 0; i < b.length; i++) {
            uint8 c = uint8(b[i]);
            if (c < 48 || c > 57) revert BadBudgetRecord();
            out = out * 10 + (c - 48);
        }
        return out;
    }
}
