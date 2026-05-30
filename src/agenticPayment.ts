/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║              CRAPAY — Agentic Payment Module                 ║
 * ║  Tích hợp Arc ERC-8183 Job Contract                         ║
 * ║                                                              ║
 * ║  Storage: 100% onchain (Arc) + localStorage                 ║
 * ║  KHÔNG dùng Firebase — mọi data đều query từ contract       ║
 * ║                                                              ║
 * ║  Flow:                                                       ║
 * ║  1) Người dùng KÝ VÍ 1 LẦN DUYUY NHẤT:                     ║
 * ║     approve(AgenticCommerce, MAX_UINT256)                    ║
 * ║  2) Mọi lần sau: tự động chạy toàn bộ lifecycle:            ║
 * ║     createJob → setBudget → fund → submit → complete        ║
 * ║  3) History: đọc từ JobCreated events onchain               ║
 * ╚══════════════════════════════════════════════════════════════╝
 */

import { ethers } from "ethers";
import Swal from "sweetalert2";

// ── Constants ──────────────────────────────────────────────────────────
const AGENTIC_COMMERCE_CONTRACT = "0x0747EEf0706327138c69792bF28Cd525089e4583";
const USDC_CONTRACT = "0x3600000000000000000000000000000000000000";
const ARC_RPC = "https://rpc.testnet.arc.network";
const ARC_EXPLORER = "https://testnet.arcscan.app";
const MAX_UINT256 = ethers.MaxUint256;

// localStorage keys — CHỈ lưu approval flag & jobId cache (không lưu data)
const LS_APPROVED_PREFIX = "crapay_agentic_approved_v1_";
const LS_JOB_IDS_PREFIX = "crapay_agentic_jobids_v1_"; // cache jobId list

// ── ABIs ───────────────────────────────────────────────────────────────
const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
] as const;

const AGENTIC_ABI = [
  "function createJob(address provider, address evaluator, uint256 expiredAt, string description, address hook) returns (uint256 jobId)",
  "function setBudget(uint256 jobId, uint256 amount, bytes optParams)",
  "function fund(uint256 jobId, bytes optParams)",
  "function submit(uint256 jobId, bytes32 deliverable, bytes optParams)",
  "function complete(uint256 jobId, bytes32 reason, bytes optParams)",
  "function getJob(uint256 jobId) view returns (tuple(uint256 id, address client, address provider, address evaluator, string description, uint256 budget, uint256 expiredAt, uint8 status, address hook))",
  "event JobCreated(uint256 indexed jobId, address indexed client, address indexed provider, address evaluator, uint256 expiredAt, address hook)",
] as const;

export const JOB_STATUS = [
  "Open", "Funded", "Submitted", "Completed", "Rejected", "Expired",
] as const;

// ── Types ──────────────────────────────────────────────────────────────
export interface AgenticPaymentOptions {
  recipient: string;
  amount: string;           // USDC (human-readable)
  description: string;
  expirySeconds?: number;
  onComplete?: (jobId: string, txHash: string) => void;
  onStep?: (step: string, detail?: string) => void;
}

export interface AgenticPaymentResult {
  jobId: string;
  txHash: string;
  status: string;
  budget: string;
}

/** Onchain job data từ getJob() */
export interface OnchainJob {
  jobId: string;
  client: string;
  provider: string;
  description: string;
  budget: string;          // formatted USDC
  expiredAt: number;       // unix timestamp
  status: string;          // "Completed", "Open", …
  statusIdx: number;
}

// ── localStorage helpers (CHỈ cho approval flag & jobId cache) ─────────

function lsIsApproved(address: string): boolean {
  try {
    return localStorage.getItem(LS_APPROVED_PREFIX + address.toLowerCase()) === "1";
  } catch { return false; }
}

function lsSetApproved(address: string): void {
  try {
    localStorage.setItem(LS_APPROVED_PREFIX + address.toLowerCase(), "1");
  } catch {}
}

function lsClearApproved(address: string): void {
  try {
    localStorage.removeItem(LS_APPROVED_PREFIX + address.toLowerCase());
  } catch {}
}

/** Cache danh sách jobId của address để tránh scan toàn bộ event log */
function lsGetJobIds(address: string): string[] {
  try {
    return JSON.parse(
      localStorage.getItem(LS_JOB_IDS_PREFIX + address.toLowerCase()) || "[]"
    );
  } catch { return []; }
}

function lsAddJobId(address: string, jobId: string): void {
  try {
    const ids = lsGetJobIds(address);
    if (!ids.includes(jobId)) {
      ids.unshift(jobId); // mới nhất đầu tiên
      localStorage.setItem(
        LS_JOB_IDS_PREFIX + address.toLowerCase(),
        JSON.stringify(ids.slice(0, 50)) // giữ tối đa 50
      );
    }
  } catch {}
}

// ── Onchain helpers ────────────────────────────────────────────────────

/** Tạo read-only provider kết nối Arc */
function getReadProvider(): ethers.JsonRpcProvider {
  return new ethers.JsonRpcProvider(ARC_RPC);
}

/** Lấy jobId từ receipt của transaction createJob */
async function extractJobId(
  provider: ethers.Provider,
  txHash: string
): Promise<bigint> {
  const receipt = await provider.getTransactionReceipt(txHash);
  if (!receipt) throw new Error("Transaction receipt not found");

  const iface = new ethers.Interface(AGENTIC_ABI);
  for (const log of receipt.logs) {
    try {
      const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
      if (parsed?.name === "JobCreated") return parsed.args.jobId as bigint;
    } catch { continue; }
  }
  throw new Error("Could not parse JobCreated event");
}

// ── Onchain query: đọc lịch sử job ───────────────────────────────────

/**
 * Đọc danh sách jobs của một address từ onchain.
 *
 * Chiến lược:
 *  1. Dùng cached jobId list trong localStorage (nhanh, không cần scan log)
 *  2. Với mỗi jobId → gọi getJob() để lấy data mới nhất từ contract
 *
 * Nếu muốn full scan events (không cache) → dùng fetchJobsFromEvents()
 */
export async function fetchJobsByAddress(address: string): Promise<OnchainJob[]> {
  const jobIds = lsGetJobIds(address);
  if (!jobIds.length) return [];

  const readProvider = getReadProvider();
  const contract = new ethers.Contract(AGENTIC_COMMERCE_CONTRACT, AGENTIC_ABI, readProvider);

  const results = await Promise.allSettled(
    jobIds.map((id) => contract.getJob(BigInt(id)))
  );

  const jobs: OnchainJob[] = [];
  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    const j = r.value;
    jobs.push({
      jobId: j.id.toString(),
      client: j.client,
      provider: j.provider,
      description: j.description,
      budget: ethers.formatUnits(j.budget, 6),
      expiredAt: Number(j.expiredAt),
      status: JOB_STATUS[Number(j.status)] ?? "Unknown",
      statusIdx: Number(j.status),
    });
  }

  return jobs;
}

/**
 * Scan toàn bộ JobCreated events onchain cho address (làm client).
 * Dùng khi cần full sync — chậm hơn nhưng không phụ thuộc cache.
 */
export async function fetchJobsFromEvents(address: string): Promise<OnchainJob[]> {
  const readProvider = getReadProvider();
  const contract = new ethers.Contract(AGENTIC_COMMERCE_CONTRACT, AGENTIC_ABI, readProvider);

  // Filter: JobCreated where client == address
  const filter = contract.filters.JobCreated(null, address);
  const events = await contract.queryFilter(filter);

  // Lấy jobIds từ events và cache lại
  const jobIds = events.map((e: any) => e.args.jobId.toString()).reverse();
  for (const id of jobIds) lsAddJobId(address, id);

  // Đọc chi tiết từng job
  const results = await Promise.allSettled(
    jobIds.map((id) => contract.getJob(BigInt(id)))
  );

  const jobs: OnchainJob[] = [];
  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    const j = r.value;
    jobs.push({
      jobId: j.id.toString(),
      client: j.client,
      provider: j.provider,
      description: j.description,
      budget: ethers.formatUnits(j.budget, 6),
      expiredAt: Number(j.expiredAt),
      status: JOB_STATUS[Number(j.status)] ?? "Unknown",
      statusIdx: Number(j.status),
    });
  }

  return jobs;
}

/**
 * Đọc 1 job theo jobId từ onchain.
 */
export async function getJobById(jobId: string): Promise<OnchainJob | null> {
  try {
    const readProvider = getReadProvider();
    const contract = new ethers.Contract(AGENTIC_COMMERCE_CONTRACT, AGENTIC_ABI, readProvider);
    const j = await contract.getJob(BigInt(jobId));
    return {
      jobId: j.id.toString(),
      client: j.client,
      provider: j.provider,
      description: j.description,
      budget: ethers.formatUnits(j.budget, 6),
      expiredAt: Number(j.expiredAt),
      status: JOB_STATUS[Number(j.status)] ?? "Unknown",
      statusIdx: Number(j.status),
    };
  } catch {
    return null;
  }
}

// ── Core: Approve một lần ─────────────────────────────────────────────

/**
 * Kiểm tra và thực hiện approve USDC cho AgenticCommerce.
 * - Có cache localStorage → bỏ qua hoàn toàn (không gọi onchain)
 * - Không cache → double-check allowance onchain → nếu đủ thì cache và skip
 * - Chưa approve → yêu cầu ký ví 1 lần duy nhất
 */
export async function ensureAgenticApproval(
  signer: ethers.JsonRpcSigner,
  onStep?: (step: string, detail?: string) => void
): Promise<void> {
  const address = await signer.getAddress();

  // 1. Kiểm tra localStorage cache
  if (lsIsApproved(address)) {
    onStep?.("✅ Already approved — no signature needed");
    return;
  }

  // 2. Double-check onchain (phòng trường hợp clear localStorage)
  const usdc = new ethers.Contract(USDC_CONTRACT, ERC20_ABI, signer);
  const allowance: bigint = await usdc.allowance(address, AGENTIC_COMMERCE_CONTRACT);
  const THRESHOLD = ethers.parseUnits("1000000", 6); // 1M USDC

  if (allowance >= THRESHOLD) {
    lsSetApproved(address);
    onStep?.("✅ Onchain allowance sufficient — skipping approval");
    return;
  }

  // 3. Chưa approve → hiện dialog giải thích rõ → ký 1 lần
  onStep?.("🔑 Requesting one-time wallet signature…");

  const confirmed = await Swal.fire({
    title: "One-time Approval Required",
    html: `
      <div style="text-align:left;font-size:14px;color:#bbb;line-height:1.7">
       <p>CRAPAY requires you to sign <strong style="color:#fff">only once</strong>
        to authorize automatic Agentic Payment transactions.
       <p style="margin-top:8px">After this step, all subsequent payments

      <strong style="color:#6c63ff">no longer require wallet signing.</p>

      <div style="background:#0f1118;border-radius:8px;padding:10px;margin-top:12px;font-size:12px;line-height:1.8">

      <div>📋 Contract: <code>${AGENTIC_COMMERCE_CONTRACT.slice(0, 10)}…${AGENTIC_COMMERCE_CONTRACT.slice(-6)}</code></div>

      <div>💰 Token: USDC (ERC-20)</div>

      <div>🔓 Allowance: Unlimited — standard ERC-20 approve</div>

      <div>🔗 Data stored 100% on-chain on Arc, not through a server</div>

      </div>
      </div>
    `,
    icon: "info",
    showCancelButton: true,
    confirmButtonText: "Approve & Continue",
    cancelButtonText: "Cancel",
    confirmButtonColor: "#6c63ff",
    background: "#161923",
    color: "#eef0ff",
  });

  if (!confirmed.isConfirmed) throw new Error("User cancelled approval");

  const tx = await usdc.approve(AGENTIC_COMMERCE_CONTRACT, MAX_UINT256);
  onStep?.("⏳ Waiting for approval transaction…", tx.hash);
  await tx.wait();

  lsSetApproved(address); // cache — lần sau không hỏi nữa
  onStep?.("✅ Approval confirmed! Future payments are fully automatic.", tx.hash);
}

// ── Core: Thực hiện Agentic Payment ───────────────────────────────────

/**
 * Thực hiện toàn bộ ERC-8183 lifecycle tự động.
 * Data KHÔNG lưu Firebase — tất cả onchain, jobId cache vào localStorage.
 */
export async function executeAgenticPayment(
  signer: ethers.JsonRpcSigner,
  options: AgenticPaymentOptions
): Promise<AgenticPaymentResult> {
  const { recipient, amount, description, expirySeconds = 86400, onStep } = options;

  const clientAddress = await signer.getAddress();
  const provider = signer.provider!;
  const agenticContract = new ethers.Contract(AGENTIC_COMMERCE_CONTRACT, AGENTIC_ABI, signer);
  const budgetWei = ethers.parseUnits(amount, 6);

  // Step 1: Đảm bảo đã approve (ký ví 1 lần nếu chưa)
  await ensureAgenticApproval(signer, onStep);

  // Step 2: Lấy block timestamp cho expiry
  const block = await provider.getBlock("latest");
  if (!block) throw new Error("Cannot fetch latest block");
  const expiredAt = BigInt(block.timestamp) + BigInt(expirySeconds);

  // Step 3: createJob
  onStep?.("📋 Creating job on Arc…");
  const createTx = await agenticContract.createJob(
    recipient,      // provider = người nhận tiền
    clientAddress,  // evaluator = chính client (tự approve)
    expiredAt,
    description,
    "0x0000000000000000000000000000000000000000"
  );
  onStep?.("⏳ Waiting for job creation…", createTx.hash);
  await createTx.wait();

  const jobId = await extractJobId(provider, createTx.hash);
  const jobIdStr = jobId.toString();

  // Cache jobId vào localStorage (để fetchJobsByAddress() chạy nhanh sau này)
  lsAddJobId(clientAddress, jobIdStr);

  onStep?.(`✅ Job #${jobIdStr} created!`, createTx.hash);

  // Step 4: setBudget
  onStep?.("💰 Setting job budget…");
  const setBudgetTx = await agenticContract.setBudget(jobId, budgetWei, "0x");
  onStep?.("⏳ Confirming budget…", setBudgetTx.hash);
  await setBudgetTx.wait();
  onStep?.(`✅ Budget set: ${amount} USDC`, setBudgetTx.hash);

  // Step 5: fund escrow
  onStep?.("🔒 Funding escrow — USDC locked in contract…");
  const fundTx = await agenticContract.fund(jobId, "0x");
  onStep?.("⏳ Confirming escrow…", fundTx.hash);
  await fundTx.wait();
  onStep?.("✅ Escrow funded!", fundTx.hash);

  // Step 6: submit deliverable
  onStep?.("📤 Submitting deliverable…");
  const deliverableHash = ethers.keccak256(
    ethers.toUtf8Bytes(`crapay-${jobIdStr}-${description}-${Date.now()}`)
  );
  const submitTx = await agenticContract.submit(jobId, deliverableHash, "0x");
  onStep?.("⏳ Confirming deliverable…", submitTx.hash);
  await submitTx.wait();
  onStep?.("✅ Deliverable submitted!", submitTx.hash);

  // Step 7: complete → USDC released to provider
  onStep?.("🏁 Completing job — releasing payment…");
  const reasonHash = ethers.keccak256(
    ethers.toUtf8Bytes(`approved-${Date.now()}`)
  );
  const completeTx = await agenticContract.complete(jobId, reasonHash, "0x");
  onStep?.("⏳ Finalizing…", completeTx.hash);
  await completeTx.wait();
  onStep?.(`🎉 Done! ${amount} USDC sent to ${recipient}`, completeTx.hash);

  // Step 8: đọc lại onchain để confirm status
  const job = await agenticContract.getJob(jobId);
  const finalStatus = JOB_STATUS[Number(job.status)] ?? "Unknown";

  return {
    jobId: jobIdStr,
    txHash: completeTx.hash,
    status: finalStatus,
    budget: ethers.formatUnits(job.budget, 6),
  };
}

// ── Exports: approval state ────────────────────────────────────────────
export const isAgenticApproved = (address: string) => lsIsApproved(address);
export const resetAgenticApproval = (address: string) => lsClearApproved(address);

// ── UI wrapper: Payment với progress modal ────────────────────────────

export async function agenticPaymentWithUI(
  signer: ethers.JsonRpcSigner,
  options: AgenticPaymentOptions
): Promise<AgenticPaymentResult | null> {
  const STEPS = [
    "Wallet approval (one-time)",
    "Create job on Arc",
    "Set payment budget",
    "Lock USDC in escrow",
    "Submit deliverable",
    "Release payment",
  ];

  let currentIdx = 0;
  let lastHash = "";

  function renderProgress(activeIdx: number, statusText: string): string {
    return `
      <div style="text-align:left;padding:4px 0">
        ${STEPS.map((s, i) => {
          const done = i < activeIdx;
          const active = i === activeIdx;
          return `
            <div style="display:flex;align-items:center;gap:10px;padding:5px 0;
                        color:${done ? "#4caf50" : active ? "#6c63ff" : "#555"};
                        font-weight:${active ? 600 : 400};font-size:13px">
              <span style="min-width:18px">${done ? "✅" : active ? "⏳" : "○"}</span>
              <span>${s}</span>
            </div>`;
        }).join("")}
        <div style="margin-top:10px;padding:8px 10px;background:#0f1118;border-radius:8px;font-size:12px;color:#aaa">
          ${statusText}
          ${lastHash
            ? `<br><a href="${ARC_EXPLORER}/tx/${lastHash}" target="_blank"
                  style="color:#6c63ff;text-decoration:none;font-size:11px">
                  View on Arcscan ↗</a>`
            : ""}
        </div>
      </div>`;
  }

  function stepToIdx(text: string): number {
    if (text.includes("approval") || text.includes("Already approved") || text.includes("allowance")) return 0;
    if (text.includes("Creating job")) return 1;
    if (text.includes("budget")) return 2;
    if (text.includes("escrow") || text.includes("Funding")) return 3;
    if (text.includes("deliverable")) return 4;
    if (text.includes("Completing") || text.includes("Finalizing") || text.includes("Done!") || text.includes("released")) return 5;
    return currentIdx;
  }

  Swal.fire({
    title: "⚡ Agentic Payment",
    html: renderProgress(0, "Initializing…"),
    showConfirmButton: false,
    allowOutsideClick: false,
    background: "#161923",
    color: "#eef0ff",
    didOpen: () => Swal.showLoading(),
  });

  try {
    const result = await executeAgenticPayment(signer, {
      ...options,
      onStep: (step, detail) => {
        currentIdx = stepToIdx(step);
        if (detail) lastHash = detail;
        const el = Swal.getHtmlContainer();
        if (el) el.innerHTML = renderProgress(currentIdx, step);
        options.onStep?.(step, detail);
      },
    });

    Swal.fire({
      icon: "success",
      title: "Payment Sent! 🎉",
      html: `
        <div style="text-align:left;font-size:14px;color:#bbb;line-height:1.9">
          <div>💸 <strong style="color:#fff">${result.budget} USDC</strong></div>
          <div>📋 Job ID: <strong style="color:#6c63ff">#${result.jobId}</strong></div>
          <div>✅ Status: <strong style="color:#4caf50">${result.status}</strong></div>
          <div>🔗 Data lưu onchain vĩnh viễn trên Arc</div>
          <div style="margin-top:10px">
            <a href="${ARC_EXPLORER}/tx/${result.txHash}" target="_blank"
               style="color:#6c63ff;font-size:13px;text-decoration:none">
              🔍 View on Arcscan ↗
            </a>
          </div>
        </div>
      `,
      background: "#161923",
      color: "#eef0ff",
      confirmButtonColor: "#6c63ff",
      confirmButtonText: "Done",
    });

    options.onComplete?.(result.jobId, result.txHash);
    return result;
  } catch (err: any) {
    const cancelled = err?.message?.includes("cancelled") || err?.code === 4001;
    Swal.fire({
      icon: cancelled ? "info" : "error",
      title: cancelled ? "Cancelled" : "Payment Failed",
      text: cancelled ? "You cancelled the payment." : (err?.message ?? "Unknown error"),
      background: "#161923",
      color: "#eef0ff",
      confirmButtonColor: "#6c63ff",
    });
    return null;
  }
}
