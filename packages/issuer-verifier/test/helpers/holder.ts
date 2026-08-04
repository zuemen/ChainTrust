/**
 * 測試用持有者：以本機金鑰產生 did:key 並簽 KB-JWT，
 * 模擬「錢包在瀏覽器端持有金鑰」的真實流程（伺服器不代管持有者私鑰）。
 */
import { createVeramoAgent, createHolderDid } from "../../src/agent.js";
import { presentKycWithKeyBinding } from "../../src/sdjwt.js";

export interface TestHolder {
  did: string;
  present(
    vc: string,
    revealKeys: string[],
    challenge: { aud: string; nonce: string }
  ): Promise<string>;
}

let cached: TestHolder | null = null;

export async function ensureTestHolder(): Promise<TestHolder> {
  if (cached) return cached;
  const agent = createVeramoAgent();
  const holder = await createHolderDid(agent, "http-test-holder");
  cached = {
    did: holder.did,
    present: (vc, revealKeys, challenge) =>
      presentKycWithKeyBinding(agent, holder, vc, revealKeys, challenge),
  };
  return cached;
}
