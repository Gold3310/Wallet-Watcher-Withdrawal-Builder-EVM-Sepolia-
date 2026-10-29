// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title WatcherWETH (wWETH)
 * @notice A wrapped-ether token you deploy, own and can actually mint against.
 *
 * @dev Why this exists
 *
 * The tracked contract is someone else's, and every balance in it belongs to
 * someone else. No amount of ownership, derivation or tooling reaches it. This
 * contract is the honest alternative: the same wrapped-ether mechanics,
 * deployed by you, owned by you, backed by ETH you put in. It gives the service
 * a full lifecycle to exercise — deploy, mint, transfer, redeem — instead of a
 * balance it can only watch.
 *
 * It is NOT Across' Bond Token, it is not affiliated with Across or Risk Labs,
 * and it must never be presented as the real thing: not in a UI, not to a
 * counterparty, not in a listing. The name and symbol are deliberately distinct
 * so nobody can confuse the two. Deploying a lookalike to pass off as another
 * project's token is fraud, and that is not what this is for.
 *
 * @dev The backing invariant
 *
 *      totalSupply == address(this).balance
 *
 * Every token in existence is a claim on one wei of ETH held by this contract.
 * Minting requires locking ETH (`deposit`); redeeming burns the token and
 * returns the ETH (`withdraw`). There is deliberately no owner-mint: a supply
 * the owner could conjure without backing is a supply that cannot be honoured,
 * and the whole point of a wrapped-ether token is that redemption always works.
 * ETH can only enter through `deposit` — there is no `receive`, so the
 * invariant cannot drift from casual transfers.
 *
 * @dev Differences from the tracked contract, on purpose
 *
 * - `transferFrom` is not gated. The tracked contract restricts transfers into
 *   its hubPool by proposer status; there is no hubPool here and no reason to
 *   restrict anything.
 * - `transferOwnership` behaves as Ownable always does: only the current owner
 *   may call it. Being the owner of this contract does NOT let you take anyone
 *   else's balance — see the backing invariant above.
 */
contract WatcherWeth {
    string public constant name = "Watcher Wrapped Ether";
    string public constant symbol = "wWETH";
    uint8 public constant decimals = 18;

    event Approval(address indexed src, address indexed guy, uint256 wad);
    event Transfer(address indexed src, address indexed dst, uint256 wad);
    event Deposit(address indexed dst, uint256 wad);
    event Withdrawal(address indexed src, uint256 wad);
    event OwnershipTransferred(
        address indexed previousOwner,
        address indexed newOwner
    );

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    /// @notice Total tokens in existence, always equal to the ETH held here.
    uint256 public totalSupply;

    /// @notice Set at construction to the deployer. Owns nothing but this role.
    address public owner;

    modifier onlyOwner() {
        require(msg.sender == owner, "WatcherWeth: caller is not the owner");
        _;
    }

    constructor() {
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    /**
     * @notice Hands the owner role to `newOwner`. Callable by the owner only.
     * @dev The role carries no power over balances — read the backing invariant
     * in the contract docblock before assuming otherwise.
     */
    function transferOwnership(address newOwner) external onlyOwner {
        require(
            newOwner != address(0),
            "WatcherWeth: new owner is the zero address"
        );
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    /// @notice Leaves the contract permanently without an owner.
    function renounceOwnership() external onlyOwner {
        emit OwnershipTransferred(owner, address(0));
        owner = address(0);
    }

    /**
     * @notice Locks `msg.value` wei of ETH and mints the same amount of wWETH.
     * @dev This is the only way tokens come into existence. Minting costs a
     * wei of ETH per wei of token, which is what keeps redemption honest.
     */
    function deposit() external payable {
        balanceOf[msg.sender] += msg.value;
        totalSupply += msg.value;
        emit Deposit(msg.sender, msg.value);
        emit Transfer(address(0), msg.sender, msg.value);
    }

    /**
     * @notice Burns `wad` wWETH and returns that much ETH to the caller.
     * @dev Ungated by design: a holder's redemption cannot be blocked by the
     * owner or anyone else. Reverts if the caller's balance is short — it
     * cannot revert for lack of ETH, because the supply is always backed.
     */
    function withdraw(uint256 wad) external {
        require(
            balanceOf[msg.sender] >= wad,
            "WatcherWeth: insufficient balance"
        );
        balanceOf[msg.sender] -= wad;
        totalSupply -= wad;
        emit Withdrawal(msg.sender, wad);
        emit Transfer(msg.sender, address(0), wad);

        (bool sent, ) = msg.sender.call{value: wad}("");
        require(sent, "WatcherWeth: ETH transfer failed");
    }

    function transfer(address dst, uint256 wad) external returns (bool) {
        return _transfer(msg.sender, dst, wad);
    }

    function transferFrom(
        address src,
        address dst,
        uint256 wad
    ) external returns (bool) {
        require(
            balanceOf[src] >= wad,
            "WatcherWeth: insufficient balance"
        );

        if (src != msg.sender && allowance[src][msg.sender] != type(uint256).max) {
            require(
                allowance[src][msg.sender] >= wad,
                "WatcherWeth: insufficient allowance"
            );
            allowance[src][msg.sender] -= wad;
        }

        return _transfer(src, dst, wad);
    }

    function approve(address guy, uint256 wad) external returns (bool) {
        allowance[msg.sender][guy] = wad;
        emit Approval(msg.sender, guy, wad);
        return true;
    }

    function _transfer(
        address src,
        address dst,
        uint256 wad
    ) internal returns (bool) {
        require(balanceOf[src] >= wad, "WatcherWeth: insufficient balance");
        balanceOf[src] -= wad;
        balanceOf[dst] += wad;
        emit Transfer(src, dst, wad);
        return true;
    }
}
