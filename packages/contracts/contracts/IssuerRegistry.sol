// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title IssuerRegistry — 信任根背書登記
/// @notice owner 代表「中華電信 PublicCA 信任根」，用來標記哪些 Issuer 位址（對應 did:ethr）可信。
///         Verifier 驗章後查 isTrustedIssuer() 判斷該 VC 的簽發者是否受信任。
/// @dev 採 Ownable2Step：移轉需 pending owner 主動 accept，避免打錯字把信任根丟給無人持有的位址。
///      renounceOwnership 被停用：信任根一旦無 owner 就再也無法撤銷外洩的 issuer，等同永久凍結。
contract IssuerRegistry is Ownable2Step {
    /// @dev issuer 位址 => 是否可信
    mapping(address => bool) private _trusted;

    event IssuerTrustChanged(address indexed issuer, bool trusted);

    /// @notice issuer 位址不可為零地址
    error ZeroIssuer();
    /// @notice 信任根不可放棄擁有權
    error RenounceDisabled();

    constructor() Ownable(msg.sender) {}

    /// @notice 停用放棄擁有權：避免信任根被永久凍結、無法撤銷外洩的 issuer
    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }

    /// @notice 設定/取消某 Issuer 的信任狀態（僅信任根 owner）
    function setTrustedIssuer(address issuer, bool trusted) external onlyOwner {
        _set(issuer, trusted);
    }

    /// @notice 批次設定信任狀態（一次背書多家銀行/機構，僅 owner）
    function setTrustedIssuers(address[] calldata issuers, bool trusted) external onlyOwner {
        for (uint256 i; i < issuers.length; ++i) {
            _set(issuers[i], trusted);
        }
    }

    function _set(address issuer, bool trusted) private {
        if (issuer == address(0)) revert ZeroIssuer();
        // 狀態未變則短路：省 gas，且讓事件流精確對應「狀態轉移」而非「呼叫次數」
        if (_trusted[issuer] == trusted) return;
        _trusted[issuer] = trusted;
        emit IssuerTrustChanged(issuer, trusted);
    }

    /// @notice 查詢某 Issuer 是否受信任
    function isTrustedIssuer(address issuer) external view returns (bool) {
        return _trusted[issuer];
    }
}
