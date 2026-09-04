// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IIssuerRegistry {
    function isTrustedIssuer(address issuer) external view returns (bool);
}

/// @title RevocationRegistry — 憑證撤銷登記（撤銷狀態以 issuer 命名空間隔離）
/// @notice 撤銷權僅限「受 IssuerRegistry（中華電信 PublicCA 根）背書的簽發者」。
///         撤銷狀態記在 (issuer, credentialHash) 兩層 mapping：每個 issuer 只能寫自己那格，
///         驗證端查詢時必須指定「該 VC 的簽發者」，因此：
///           - 受信任 issuer B 無法影響 A 簽發之 VC 的撤銷狀態（無跨 issuer 汙染）；
///           - 不存在「先撤銷者搶下 issuer 綁定」的搶註冊/前置攻擊（無隱式綁定可搶）；
///           - 未受信任的第三方無法撤銷任何 VC。
///         注意：revocationKey/credentialHash 會出現在出示流程中，任何收到出示的機構都知道 hash，
///         故「撤銷權必須由 msg.sender 決定，而非由 hash 決定」是本設計的核心。
contract RevocationRegistry {
    /// @notice 信任根登記（用於授權撤銷者）
    IIssuerRegistry public immutable issuerRegistry;

    /// @notice revokeBatch 單筆交易上限（避免 gas 爆量 / DoS）
    uint256 public constant MAX_BATCH = 200;

    /// @dev issuer => credentialHash => 是否已撤銷（issuer 命名空間隔離）
    mapping(address => mapping(bytes32 => bool)) private _revoked;

    event CredentialRevoked(address indexed issuer, bytes32 indexed credentialHash);
    event CredentialUnrevoked(address indexed issuer, bytes32 indexed credentialHash);

    /// @notice IssuerRegistry 位址不可為零、且必須是合約
    error ZeroRegistry();
    /// @notice 呼叫者非受信任根背書的簽發者
    error UntrustedIssuer();
    /// @notice 批次長度超過 MAX_BATCH 或為 0
    error InvalidBatchLength();

    constructor(address issuerRegistry_) {
        if (issuerRegistry_ == address(0)) revert ZeroRegistry();
        // 誤填 EOA 會讓本合約永久無法通過 onlyTrustedIssuer（呼叫 EOA 的 view 會 revert）而報廢
        if (issuerRegistry_.code.length == 0) revert ZeroRegistry();
        issuerRegistry = IIssuerRegistry(issuerRegistry_);
    }

    /// @dev 僅信任根背書的簽發者可呼叫
    modifier onlyTrustedIssuer() {
        if (!issuerRegistry.isTrustedIssuer(msg.sender)) revert UntrustedIssuer();
        _;
    }

    /// @notice 撤銷自己簽發的一張 VC（只寫 msg.sender 的命名空間）
    function revoke(bytes32 credentialHash) external onlyTrustedIssuer {
        _revoked[msg.sender][credentialHash] = true;
        emit CredentialRevoked(msg.sender, credentialHash);
    }

    /// @notice 批次撤銷（事故時大量撤銷），只寫 msg.sender 的命名空間
    function revokeBatch(bytes32[] calldata credentialHashes) external onlyTrustedIssuer {
        uint256 len = credentialHashes.length;
        if (len == 0 || len > MAX_BATCH) revert InvalidBatchLength();
        for (uint256 i; i < len; ++i) {
            _revoked[msg.sender][credentialHashes[i]] = true;
            emit CredentialRevoked(msg.sender, credentialHashes[i]);
        }
    }

    /// @notice 復原撤銷（只寫 msg.sender 的命名空間；仍需為受信任 issuer）
    function unrevoke(bytes32 credentialHash) external onlyTrustedIssuer {
        _revoked[msg.sender][credentialHash] = false;
        emit CredentialUnrevoked(msg.sender, credentialHash);
    }

    /// @notice 查詢「某 issuer 簽發的某 VC」是否已撤銷
    function isRevoked(address issuer, bytes32 credentialHash) external view returns (bool) {
        return _revoked[issuer][credentialHash];
    }
}
