import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";

dotenv.config();

// 從 .env 讀私鑰（勿入庫）。無私鑰時 accounts 為空，本地測試仍可跑。
const AMOY_RPC_URL = process.env.AMOY_RPC_URL ?? "https://rpc-amoy.polygon.technology";
const DEPLOYER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY;

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      // 明寫 evmVersion，避免不同 solc 版本的預設值漂移導致位元組碼不可重現。
      // 選 "shanghai" 而非 "cancun"：Polygon PoS（含 Amoy）對 Cancun 系列 opcode
      // （尤其 EIP-1153 TSTORE/TLOAD）的支援時程晚於 L1，且本專案兩份合約完全沒用到
      // Cancun 才有的功能，鎖 shanghai 可零成本換得最大部署相容性。
      evmVersion: "shanghai",
    },
  },
  networks: {
    hardhat: {},
    amoy: {
      url: AMOY_RPC_URL,
      chainId: 80002,
      accounts: DEPLOYER_PRIVATE_KEY ? [DEPLOYER_PRIVATE_KEY] : [],
    },
  },
};

export default config;
