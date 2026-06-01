import { ethers } from "ethers";
import Swal from "sweetalert2";
import QRCode from "qrcode";
import { Html5Qrcode } from "html5-qrcode";

import { initializeApp } from "firebase/app";
import {
  getFirestore,
  collection,
  query,
  where,
  getDocs,
  deleteDoc,
  doc,
  setDoc,
  writeBatch,
} from "firebase/firestore";

import {
  agenticPaymentWithUI,
  executeAgenticPayment,
  ensureAgenticApproval,
  fetchJobsByAddress,
  fetchJobsFromEvents,
  type OnchainJob,
} from './agenticPayment';

// ── Types ──────────────────────────────────────────────────
// Fix #10: EIP1193Provider từ viem không có .on() → tự declare
interface EthereumProvider {
  request(args: { method: string; params?: any[] }): Promise<any>;
  on?(event: string, handler: (...args: any[]) => void): void;
  removeListener?(event: string, handler: (...args: any[]) => void): void;
}

declare global {
  interface Window {
    ethereum?: EthereumProvider;
  }
}

interface TxHistory {
  hash?: string;
  from?: string;
  to?: string;
  amount: string;
  token: string;
  type: string;
  msg?: string;
  tag?: string;
  ts: number;
  blockNumber?: number;
  ownerAddress?: string;
}

interface AppState {
  address: string | null;
  provider: ethers.BrowserProvider | null;
  signer: ethers.JsonRpcSigner | null;
  usdcBal: string;
  eurcBal: string;
  history: TxHistory[];
  contacts: any[];
  schedules: any[];
  paymentLinks: any[];
  splitBills: any[];
  alerts: any[];
  notifications: any[];
}

// ── Constants ──────────────────────────────────────────────
const ARC = {
  chainId: 0x4cef52,
  chainIdHex: "0x4CEF52",
  rpc: "https://rpc.testnet.arc.network",
  explorer: "https://testnet.arcscan.app",
  name: "Arc Testnet",
  currency: "USDC",
  contracts: {
    USDC: "0x3600000000000000000000000000000000000000",
    EURC: "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a",
    FxEscrow: "0x867650F5eAe8df91445971f14d89fd84F0C9a9f8",
    Multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11",
    Permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
    GatewayWallet: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9",
  },
} as const;

const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
] as const;

const LS_WALLET_KEY = "crapay_wallet_session";

// ── Firebase ───────────────────────────────────────────────
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};
const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp, "hanzzz");

// ── State ──────────────────────────────────────────────────
let isBooting = true;

let state: AppState = {
  address: null,
  provider: null,
  signer: null,
  usdcBal: "0.00",
  eurcBal: "0.00",
  history: [],
  contacts: [],
  schedules: [],
  paymentLinks: [],
  splitBills: [],
  alerts: [],
  notifications: [],
};

// ── LocalStorage ───────────────────────────────────────────
interface WalletSession {
  address: string;
  usdcBal: string;
  eurcBal: string;
}

function lsSaveWallet(): void {
  if (!state.address) return;
  localStorage.setItem(
    LS_WALLET_KEY,
    JSON.stringify({
      address: state.address,
      usdcBal: state.usdcBal,
      eurcBal: state.eurcBal,
    } satisfies WalletSession),
  );
}

function lsLoadWallet(): WalletSession | null {
  try {
    return JSON.parse(localStorage.getItem(LS_WALLET_KEY) || "null");
  } catch {
    return null;
  }
}

function lsClearWallet(): void {
  localStorage.removeItem(LS_WALLET_KEY);
}

async function debugChainFetch(): Promise<void> {
  if (!state.address) { console.log("No address"); return; }
  console.log("=== DEBUG CHAIN FETCH ===");
  console.log("Address:", state.address);
  
  try {
    const rpc = new ethers.JsonRpcProvider(ARC.rpc);
    
    // Check RPC connect được không
    const latest = await rpc.getBlockNumber();
    console.log("Latest block:", latest);
    console.log("fromBlock:", Math.max(0, latest - 10000));
    
    const iface = new ethers.Interface([
      "event Transfer(address indexed from, address indexed to, uint256 value)"
    ]);
    const transferTopic = iface.getEvent("Transfer")!.topicHash;
    const user = ethers.getAddress(state.address);
    const userTopic = ethers.zeroPadValue(user, 32);
    
    console.log("userTopic:", userTopic);
    
    // Chỉ check USDC sent logs
    const fromBlock = Math.max(0, latest - 10000);
    const sentLogs = await rpc.getLogs({
      address: ARC.contracts.USDC,
      topics: [transferTopic, userTopic, null],
      fromBlock,
      toBlock: latest,
    });
    console.log("USDC sent logs:", sentLogs.length);

    const recvLogs = await rpc.getLogs({
      address: ARC.contracts.USDC,
      topics: [transferTopic, null, userTopic],
      fromBlock,
      toBlock: latest,
    });
    console.log("USDC recv logs:", recvLogs.length);

    // Thử range rộng hơn — 50000 blocks
    const fromBlock2 = Math.max(0, latest - 50000);
    const sentLogs2 = await rpc.getLogs({
      address: ARC.contracts.USDC,
      topics: [transferTopic, userTopic, null],
      fromBlock: fromBlock2,
      toBlock: latest,
    });
    console.log("USDC sent logs (50k blocks):", sentLogs2.length);

    const recvLogs2 = await rpc.getLogs({
      address: ARC.contracts.USDC,
      topics: [transferTopic, null, userTopic],
      fromBlock: fromBlock2,
      toBlock: latest,
    });
    console.log("USDC recv logs (50k blocks):", recvLogs2.length);

  } catch (e) {
    console.error("Chain fetch error:", e);
  }
  console.log("=== END ===");
}
(window as any).debugChainFetch = debugChainFetch;

// ── Firestore helpers ──────────────────────────────────────
// Fix #17: LUÔN filter ownerAddress — không fallback không-filter nữa
// (path đã scoped theo address rồi, ownerAddress là lớp bảo vệ thứ 2)

function userCol(sub: string) {
  if (!state.address) throw new Error("Wallet not connected");
  return collection(db, "users", state.address.toLowerCase(), sub);
}

function userDocRef(sub: string, id: string) {
  if (!state.address) throw new Error("Wallet not connected");
  return doc(db, "users", state.address.toLowerCase(), sub, id);
}

// Fix #17: luôn filter ownerAddress, không fallback không-filter
async function fbLoadAll(sub: string): Promise<any[]> {
  if (!state.address) return [];
  const snap = await getDocs(
    query(
      userCol(sub),
      where("ownerAddress", "==", state.address.toLowerCase()),
    ),
  );
  return snap.docs.map((d) => ({ _fbId: d.id, ...d.data() }));
}

// Upsert — LUÔN ghi ownerAddress
async function fbSave(sub: string, item: any): Promise<void> {
  if (!state.address) throw new Error("Wallet not connected");
  const id = String(item.id ?? item._fbId ?? Date.now());
  const { _fbId, ...rest } = item;
  await setDoc(
    userDocRef(sub, id),
    {
      ...rest,
      ownerAddress: state.address.toLowerCase(),
      updatedAt: Date.now(),
    },
    { merge: true },
  );
}

async function fbDelete(sub: string, id: string | number): Promise<void> {
  await deleteDoc(userDocRef(sub, String(id)));
}

// ── XSS sanitize helper ────────────────────────────────────
// Fix #7, #8: sanitize tất cả user-controlled text trước khi đưa vào innerHTML
function sanitize(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;")
    .replace(/\//g, "&#x2F;");
}

// ── Load user data ─────────────────────────────────────────
async function loadUserData(): Promise<void> {
  if (!state.address) return;
  try {
    const [
      contacts,
      schedules,
      paymentLinks,
      splitBills,
      alerts,
      notifications,
    ] = await Promise.all([
      fbLoadAll("contacts"),
      fbLoadAll("schedules"),
      fbLoadAll("paymentLinks"),
      fbLoadAll("splitBills"),
      fbLoadAll("alerts"),
      fbLoadAll("notifications"),
    ]);
    state.contacts = contacts;
    state.schedules = schedules;
    state.paymentLinks = paymentLinks;
    state.splitBills = splitBills;
    state.alerts = alerts;

    if (notifications.length === 0) {
      const first = {
        id: Date.now(),
        text: "CRAPAY connected to Arc Testnet",
        time: Date.now(),
        read: false,
      };
      state.notifications = [first];
      await fbSave("notifications", first);
    } else {
      state.notifications = notifications.sort((a, b) => b.time - a.time);
    }
    // Sync agentic approval flag từ Firebase vào localStorage
    await syncAgenticApprovalFromFb().catch(() => {});
  } catch (e) {
    console.error("loadUserData error", e);
  }
}

// ── Navigation ─────────────────────────────────────────────
const PAGE_TITLES: Record<string, string> = {
  home: "Dashboard",
  send: "Send Payment",
  qrpay: "QR Payment",
  scanqr: "Scan QR",
  multisend: "Multi-send",
  split: "Split Bill",
  paylink: "Payment Link",
  schedule: "Scheduled Payments",
  contacts: "Contacts",
  analytics: "Analytics",
  history: "History & Export",
  alerts: "Price Alerts",
  agentic: "Agentic Payment",
};

function nav(id: string) {
  document
    .querySelectorAll(".page")
    .forEach((p) => p.classList.remove("active"));
  document
    .querySelectorAll(".nav-item")
    .forEach((n) => n.classList.remove("active"));
  // sync mobile bottom nav
  document.querySelectorAll(".mobile-nav-item").forEach((n) => {
    n.classList.toggle(
      "active",
      n.getAttribute("onclick")?.includes(`'${id}'`) ?? false,
    );
  });
  const page = document.getElementById("page-" + id);
  if (!page) return;
  page.classList.add("active");
  document.querySelectorAll(".nav-item").forEach((n) => {
    if (n.getAttribute("onclick")?.includes(`'${id}'`))
      n.classList.add("active");
  });
  const titleEl = document.getElementById("page-title");
  if (titleEl) titleEl.textContent = PAGE_TITLES[id] || id;
  onPageLoad(id);
}
(window as any).nav = nav;

const LS_DISCONNECT_KEY = "crapay_disconnected";

function lsSetDisconnected(): void {
  localStorage.setItem(LS_DISCONNECT_KEY, "1");
}

function lsClearDisconnected(): void {
  localStorage.removeItem(LS_DISCONNECT_KEY);
}

function lsIsDisconnected(): boolean {
  return localStorage.getItem(LS_DISCONNECT_KEY) === "1";
}

function onPageLoad(id: string) {
  if (id === "contacts") {
    renderContacts();
    renderSplitParticipants();
  }
 if (id === "schedule") {
  renderSchedules();
  const dateEl = document.getElementById("sched-date") as HTMLInputElement | null;
  if (dateEl) {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const iso = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, "0")}-${String(tomorrow.getDate()).padStart(2, "0")}`;
    dateEl.min = iso;
    dateEl.value = iso;
  }
}
  if (id === "paylink") {
    updateLinkPreview();
    renderLinks();
  }
  if (id === "split") {
    renderSplitParticipants();
    renderSplitHistory();
  }
  if (id === "history") {
    if (state.history.length) renderHistory();
  }
  if (id === "analytics") loadAnalytics();
  if (id === "alerts") renderAlerts();
  if (id === "home") {
    renderHomeSchedule();
    renderHomeTx();
  }
  if (id === "send") {
    updateSendBalances();
    updateContactDatalist();
  }
  if (id === "agentic") initAgenticPage();
}
(window as any).onPageLoad = onPageLoad;

// ── Network ────────────────────────────────────────────────
async function ensureArcNetwork(): Promise<void> {
  if (!window.ethereum) throw new Error("No wallet");
  const currentChainId: string = await window.ethereum.request({
    method: "eth_chainId",
  });
  if (currentChainId.toLowerCase() === ARC.chainIdHex.toLowerCase()) return;
  try {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: ARC.chainIdHex }],
    });
  } catch (err: any) {
    if (err.code === 4902) {
      // Chain chưa có trong MetaMask — thử xóa rồi add lại
      try {
        await window.ethereum.request({
          method: "wallet_addEthereumChain",
          params: [
            {
              chainId: ARC.chainIdHex,
              chainName: ARC.name,
              rpcUrls: [ARC.rpc],
              blockExplorerUrls: [ARC.explorer],
              nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
            },
          ],
        });
      } catch (addErr: any) {
        // -32603: RPC endpoint đã tồn tại cho chain khác
        // Trường hợp này MetaMask đang có Arc với chainId khác
        // → switch sang chainId hiện tại MetaMask đang nhận diện
        if (addErr.code === -32603) {
          // Không làm gì — MetaMask đã có Arc network, chỉ cần switch
          await window.ethereum.request({
            method: "wallet_switchEthereumChain",
            params: [{ chainId: currentChainId }],
          });
          // Nếu chainId không khớp ARC.chainIdHex thì báo lỗi rõ
          const afterSwitch: string = await window.ethereum.request({
            method: "eth_chainId",
          });
          if (afterSwitch.toLowerCase() !== ARC.chainIdHex.toLowerCase()) {
            throw new Error(
              `Please manually switch to Arc Testnet in MetaMask (Chain ID: ${ARC.chainId})`,
            );
          }
          return;
        }
        throw addErr;
      }
    } else if (err.code === -32603) {
      throw new Error(
        `Please manually switch to Arc Testnet in MetaMask (Chain ID: ${ARC.chainId})`,
      );
    } else {
      throw err;
    }
  }
}
(window as any).ensureArcNetwork = ensureArcNetwork;

// ── Wallet ─────────────────────────────────────────────────
async function handleWalletClick() {
  if (state.address) {
    disconnectWallet();
    return;
  }
  await connectWallet();
}
(window as any).handleWalletClick = handleWalletClick;

async function connectWallet() {
  if (!window.ethereum) {
    Swal.fire({
      icon: "error",
      title: "No Wallet",
      text: "Please install MetaMask or OKX Wallet",
      background: "#0f1118",
      color: "#eef0ff",
      confirmButtonColor: "#6c63ff",
    });
    return;
  }
  try {
    const rawAccounts: string[] = await window.ethereum.request({
      method: "eth_requestAccounts",
    });
    if (!rawAccounts.length) return;

    lsClearDisconnected();

    state.address = rawAccounts[0];
    state.provider = new ethers.BrowserProvider(window.ethereum as any);
    state.signer = await state.provider.getSigner();

    await ensureArcNetwork();

    state.provider = new ethers.BrowserProvider(window.ethereum as any);
    state.signer = await state.provider.getSigner();

    await refreshBalances();
    await loadUserData();
    lsSaveWallet();

    // Load history sau khi có address
    await loadHistoryHome();

    updateWalletUI();
    renderContacts();
    renderSchedules();
    renderHomeSchedule();
    renderHomeTx();
    renderNotifs();
    renderAlerts();
    renderLinks();
    renderSplitHistory();
    renderHistory();
    updateContactDatalist();
    buildAnalytics();

    toast("success", `Connected: ${shortAddr(state.address)}`);
  } catch (e: any) {
    if (e.code === 4001) return;
    console.error(e);
    toast("error", e.message ?? "Connection failed");
  }
}
(window as any).connectWallet = connectWallet;

// Fix #16: render all lists empty on disconnect
function disconnectWallet() {
  lsSetDisconnected();
  lsClearWallet();

  state = {
    address: null,
    provider: null,
    signer: null,
    usdcBal: "0.00",
    eurcBal: "0.00",
    history: [],
    contacts: [],
    schedules: [],
    paymentLinks: [],
    splitBills: [],
    alerts: [],
    notifications: [],
  };

  // Reset toàn bộ UI
  updateWalletUI();
  updateBalanceUI();
  renderContacts();
  renderSchedules();
  renderHomeSchedule();
  renderHomeTx();
  renderNotifs();
  renderAlerts();
  renderLinks();
  renderSplitHistory();
  renderHistory();
  updateContactDatalist();

  // Reset stat cards về —
  [
    "home-usdc",
    "home-eurc",
    "home-sent",
    "home-recv",
    "ana-sent",
    "ana-recv",
    "ana-count",
    "ana-net",
    "ana-usdc-vol",
    "ana-eurc-vol",
  ].forEach((id) => setText(id, "—"));

  // Reset chart
  const bars = document.getElementById("chart-bars");
  const lbls = document.getElementById("chart-labels");
  if (bars) bars.innerHTML = "";
  if (lbls) lbls.innerHTML = "";
  const tagEl = document.getElementById("tag-breakdown");
  if (tagEl)
    tagEl.innerHTML =
      '<div class="empty-state text-xs">Load history to see breakdown</div>';

  toast("info", "Wallet disconnected");
}
(window as any).disconnectWallet = disconnectWallet;

async function refreshBalances() {
  if (!state.address) return;
  try {
    const rpc = new ethers.JsonRpcProvider(ARC.rpc);
    const [uB, eB] = await Promise.all([
      getTokenBal(rpc, ARC.contracts.USDC, state.address),
      getTokenBal(rpc, ARC.contracts.EURC, state.address),
    ]);
    state.usdcBal = uB;
    state.eurcBal = eB;
    updateBalanceUI();
  } catch (e) {
    console.error("Balance error", e);
  }
}
(window as any).refreshBalances = refreshBalances;

async function getTokenBal(
  provider: ethers.Provider,
  addr: string,
  wallet: string,
): Promise<string> {
  const c = new ethers.Contract(addr, ERC20_ABI, provider);
  const raw = await c.balanceOf(wallet);
  let dec = 6; // ARC USDC/EURC default
  try {
    dec = Number(await c.decimals());
  } catch {
    /* keep default */
  }
  return Number(ethers.formatUnits(raw, dec)).toFixed(2);
}
(window as any).getTokenBal = getTokenBal;

function updateWalletUI() {
  const dot = document.getElementById("wallet-dot");
  const lbl = document.getElementById("wallet-label");
  const disp = document.getElementById("balance-display");
  if (!dot || !lbl || !disp) return;
  if (state.address) {
    dot.className = "dot connected";
    lbl.textContent = shortAddr(state.address);
    disp.style.display = "block";
    updateBalanceUI();
  } else {
    dot.className = "dot disconnected";
    lbl.textContent = "Connect Wallet";
    disp.style.display = "none";
  }
}
(window as any).updateWalletUI = updateWalletUI;

function updateBalanceUI() {
  const disp = document.getElementById("balance-display");
  if (disp) disp.textContent = `${state.usdcBal} USDC · ${state.eurcBal} EURC`;
  setText("home-usdc", state.usdcBal + " USDC");
  setText("home-eurc", state.eurcBal + " EURC");
  setText("send-usdc-bal", state.usdcBal + " USDC");
  setText("send-eurc-bal", state.eurcBal + " EURC");
}
(window as any).updateBalanceUI = updateBalanceUI;

// ── Auto-reconnect on load ─────────────────────────────────
window.addEventListener("load", async () => {
  isBooting = true;

  const saved = lsLoadWallet();
  if (saved) {
    state.address = saved.address;
    state.usdcBal = saved.usdcBal;
    state.eurcBal = saved.eurcBal;
    updateWalletUI();
  }

  if (!window.ethereum) {
    if (saved) {
      await loadUserData().catch(() => {});
      renderHomeSchedule();
      renderHomeTx();
    }
    isBooting = false;
    return;
  }

  if (lsIsDisconnected()) {
    isBooting = false;
    state.address = null;
    state.usdcBal = "0.00";
    state.eurcBal = "0.00";
    updateWalletUI();
    return;
  }

  const accounts: string[] = await window.ethereum.request({
    method: "eth_accounts",
  });

  if (accounts.length) {
    state.address = accounts[0];
    state.provider = new ethers.BrowserProvider(window.ethereum as any);
    state.signer = null;
    updateWalletUI();

    try {
      await refreshBalances();
      await loadUserData();
      lsSaveWallet();
      updateWalletUI();

      await loadHistoryHome();
      renderHomeSchedule();
      renderHomeTx();
      renderHistory();
      buildAnalytics();
    } catch (e) {
      console.error("Auto-reconnect error", e);
    }
  }

  window.ethereum.on?.(
    "accountsChanged",
    async (newAccounts: string[]): Promise<void> => {
      if (!newAccounts.length) {
        disconnectWallet();
        return;
      }

      lsClearDisconnected();
      state.address = newAccounts[0];
      state.provider = new ethers.BrowserProvider(window.ethereum as any);
      state.signer = await state.provider.getSigner();
      state.history = [];
      state.contacts = [];
      state.schedules = [];
      state.paymentLinks = [];
      state.splitBills = [];
      state.alerts = [];
      state.notifications = [];

      updateWalletUI();
      await refreshBalances();
      await loadUserData();
      lsSaveWallet();
      updateWalletUI();

      await loadHistoryHome();

      renderContacts();
      renderSchedules();
      renderHomeSchedule();
      renderHomeTx();
      renderNotifs();
      renderAlerts();
      renderLinks();
      renderSplitHistory();
      renderHistory();
      updateContactDatalist();

      toast("info", `Switched to ${shortAddr(newAccounts[0])}`);
    },
  );

  window.ethereum.on?.("chainChanged", async (chainId: string) => {
    if (chainId.toLowerCase() !== ARC.chainIdHex.toLowerCase()) {
      toast("error", "Wrong network — switching to Arc Testnet…");
      try {
        await ensureArcNetwork();
        toast("success", "Switched to Arc Testnet");
        await refreshBalances();
      } catch {
        toast("error", "Please switch to Arc Testnet manually");
      }
    } else {
      await refreshBalances();
    }
  });

  isBooting = false;
});

// ── sendOnChain ────────────────────────────────────────────
// Fix #6: không corrupt state nếu ensureArcNetwork throw
async function sendOnChain(
  to: string,
  amount: string,
  token: string,
  _msg?: string,
  _tag?: string,
): Promise<ethers.TransactionResponse> {
  if (!state.address || !window.ethereum)
    throw new Error("Wallet not connected");

  // ── 1. Đảm bảo đúng network ───────────────────────────────
  await ensureArcNetwork();

  const contractAddr =
    token === "EURC" ? ARC.contracts.EURC : ARC.contracts.USDC;
  const dec = 6;
  const amountBN = ethers.parseUnits(amount, dec);

  // ── 2. Encode calldata thủ công ────────────────────────────
  const iface = new ethers.Interface([
    "function transfer(address to, uint256 amount) returns (bool)",
  ]);
  const data = iface.encodeFunctionData("transfer", [to, amountBN]);

  // ── 3. Estimate gas qua public RPC (không qua wallet) ──────
  // Tránh OKX/Trust block estimateGas qua provider
  const publicRpc = new ethers.JsonRpcProvider(ARC.rpc);
  const gasHex = "0x30D40";

  // ── 4. Lấy nonce hiện tại ──────────────────────────────────
  let nonceHex: string | undefined;
  try {
    const nonce = await publicRpc.getTransactionCount(state.address, "pending");
    nonceHex = "0x" + nonce.toString(16);
  } catch {
    // để wallet tự quản lý nonce nếu lỗi
  }

  const txParams: Record<string, any> = {
    from: state.address,
    to: contractAddr,
    data,
    gas: gasHex,
    value: "0x0",
  };
  if (nonceHex) txParams.nonce = nonceHex;

  // ── 5. Gửi transaction ─────────────────────────────────────
  // Dùng window.ethereum.request trực tiếp — hoạt động trên tất cả ví
  // (MetaMask, OKX, Trust, Coinbase, Rabby đều implement eth_sendTransaction)
  let txHash: string;
  try {
    txHash = await window.ethereum.request({
      method: "eth_sendTransaction",
      params: [txParams],
    });
  } catch (err: any) {
    // User rejected (code 4001) hoặc lỗi ví
    if (err?.code === 4001 || err?.code === "ACTION_REJECTED") {
      throw new Error("Transaction rejected by user");
    }
    throw err;
  }

  if (!txHash || typeof txHash !== "string") {
    throw new Error("No transaction hash returned");
  }

  // ── 6. Wait for confirmation qua public RPC ────────────────
  // Không dùng wallet provider để wait — tránh OKX/Trust timeout
  const waitReceipt = async (): Promise<ethers.TransactionReceipt> => {
    const MAX_ATTEMPTS = 60;
    const INTERVAL_MS = 2000;
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      try {
        const receipt = await publicRpc.getTransactionReceipt(txHash);
        if (receipt && receipt.status !== null) {
          if (receipt.status === 0)
            throw new Error("Transaction reverted on-chain");
          return receipt;
        }
      } catch (e: any) {
        if (e?.message?.includes("reverted")) throw e;
        // lỗi RPC tạm thời → tiếp tục poll
      }
      await new Promise((r) => setTimeout(r, INTERVAL_MS));
    }
    throw new Error("Transaction not confirmed after 2 minutes");
  };

  // ── 7. Lấy TransactionResponse để tương thích code cũ ──────
  // Thử lấy response từ RPC, nếu không có thì wrap minimal object
  let txResponse: ethers.TransactionResponse | null = null;
  for (let i = 0; i < 15; i++) {
    txResponse = await publicRpc.getTransaction(txHash).catch(() => null);
    if (txResponse) break;
    await new Promise((r) => setTimeout(r, 1000));
  }

  if (txResponse) {
    // Có đầy đủ response — wait bình thường
    await waitReceipt();
    return txResponse;
  }

  // Fallback: wrap hash vào minimal TransactionResponse-compatible object
  await waitReceipt();
  return {
    hash: txHash,
    from: state.address,
    to: contractAddr,
    data,
    value: 0n,
    chainId: BigInt(ARC.chainId),
    nonce: 0,
    gasLimit: BigInt(gasHex),
    gasPrice: null,
    maxFeePerGas: null,
    maxPriorityFeePerGas: null,
    type: 0,
    blockHash: null,
    blockNumber: null,
    index: null,
    accessList: [],
    signature: null as any,
    provider: publicRpc,
    wait: async () => waitReceipt(),
    confirmations: async () => 1,
    isMined: () => false,
    removedEvent: () => ({}) as any,
    revertedEvent: () => ({}) as any,
    replaceableEvent: () => ({}) as any,
    getTransaction: async () => txResponse!,
    toJSON: () => ({ hash: txHash }),
  } as unknown as ethers.TransactionResponse;
}
(window as any).sendOnChain = sendOnChain;

// ── Send Payment ───────────────────────────────────────────
async function doSend(): Promise<void> {
  if (!requireWallet()) return;
  const to = (
    document.getElementById("send-to") as HTMLInputElement
  ).value.trim();
  const amount = (
    document.getElementById("send-amount") as HTMLInputElement
  ).value.trim();
  const msg =
    (document.getElementById("send-msg") as HTMLInputElement)?.value.trim() ??
    "";
  const tag =
    (document.getElementById("send-tag") as HTMLInputElement)?.value.trim() ??
    "";
  const token = getActiveToken("send-token-tabs") ?? "USDC";

  if (!ethers.isAddress(to)) {
    toast("error", "Invalid recipient address");
    return;
  }
  if (!amount || parseFloat(amount) <= 0) {
    toast("error", "Enter a valid amount");
    return;
  }

  const btn = document.getElementById("send-btn") as HTMLButtonElement | null;
  setLoading(btn, true);
  try {
    const result = await sendOnChain(to, amount, token, msg, tag);
    clearFields(["send-to", "send-amount", "send-msg"]);
    await refreshBalances();

    // Fix #1: closeModal() không có tham số
    showSuccessModal(
      `💸 Payment Sent!`,
      `
      <div class="card-inner mb-12">
        <div class="text-xs text-muted mb-4">Amount</div>
        <div class="fw700 mono" style="font-size:20px;color:var(--p2)">${sanitize(amount)} ${sanitize(token)}</div>
      </div>
      <div class="card-inner mb-12">
        <div class="text-xs text-muted mb-4">To</div>
        <div class="fw600 mono text-sm">${sanitize(to)}</div>
      </div>
      ${msg ? `<div class="card-inner mb-12"><div class="text-xs text-muted mb-4">Message</div><div class="text-sm">${sanitize(msg)}</div></div>` : ""}
      <div class="card-inner mb-16">
        <div class="text-xs text-muted mb-4">Transaction</div>
        <a href="${ARC.explorer}/tx/${result.hash}" target="_blank" class="mono text-xs">${shortHash(result.hash)}</a>
      </div>
      <button class="btn btn-secondary btn-full" onclick="closeModal()">Done</button>
    `,
    );

    await pushNotif(`Sent ${amount} ${token} to ${shortAddr(to)}`);
    await addToHistory({
      hash: result.hash,
      from: state.address!,
      to,
      amount,
      token,
      type: "sent",
      msg,
      tag,
      ts: Date.now(),
    });

    const contact = state.contacts.find(
      (c: any) => c.address.toLowerCase() === to.toLowerCase(),
    );
    if (contact) {
      contact.totalSent = (contact.totalSent || 0) + parseFloat(amount);
      await fbSave("contacts", contact);
    }
  } catch (err: unknown) {
    toast("error", err instanceof Error ? err.message : "Transaction failed");
  } finally {
    setLoading(btn, false, "Send Payment");
  }
}
(window as any).doSend = doSend;

// ── Multi-send ─────────────────────────────────────────────
type Recipient = { to: string; amount: string };
type TxResult = Recipient & { hash: string };
type TxError = Recipient & { error: string };

async function doMultiSend(): Promise<void> {
  if (!requireWallet()) return;
  const rows = document.querySelectorAll("#multi-recipients .recipient-row");
  const token = getActiveToken("multi-token-tabs") ?? "USDC";
  const msg =
    (document.getElementById("multi-msg") as HTMLInputElement)?.value ?? "";
  const recipients: Recipient[] = [];

  for (const row of rows) {
    const inputs = row.querySelectorAll(
      "input",
    ) as NodeListOf<HTMLInputElement>;
    const addr = inputs[0]?.value.trim();
    const amt = inputs[1]?.value.trim();
    if (!addr || !amt) continue;

    // Fix #3: validate address before queuing
    if (!ethers.isAddress(addr)) {
      toast("error", `Invalid address: ${shortAddr(addr)}`);
      return;
    }
    if (parseFloat(amt) <= 0) {
      toast("error", `Invalid amount for ${shortAddr(addr)}`);
      return;
    }
    recipients.push({ to: addr, amount: amt });
  }

  if (!recipients.length) {
    toast("error", "Add at least one recipient");
    return;
  }

  const total = recipients
    .reduce((s, r) => s + parseFloat(r.amount), 0)
    .toFixed(2);
  const confirmed = await Swal.fire({
    title: `Send to ${recipients.length} recipients?`,
    text: `Total: ${total} ${token}`,
    icon: "question",
    showCancelButton: true,
    confirmButtonText: "Send All",
    background: "#0f1118",
    color: "#eef0ff",
    confirmButtonColor: "#6c63ff",
  });
  if (!confirmed.isConfirmed) return;

  Swal.fire({
    title: "Sending…",
    text: "Confirm each transaction in your wallet.",
    allowOutsideClick: false,
    didOpen: () => Swal.showLoading(),
    background: "#0f1118",
    color: "#eef0ff",
  });

  const results: TxResult[] = [];
  const errors: TxError[] = [];

  for (const r of recipients) {
    try {
      const tx = await sendOnChain(r.to, r.amount, token, msg);
      results.push({ ...r, hash: tx.hash });
      // Fix #4: addToHistory for each successful tx
      await addToHistory({
        hash: tx.hash,
        from: state.address!,
        to: r.to,
        amount: r.amount,
        token,
        type: "sent",
        msg,
        ts: Date.now(),
      });
    } catch (e: unknown) {
      errors.push({ ...r, error: e instanceof Error ? e.message : String(e) });
    }
  }

  Swal.close();
  await refreshBalances();

  showSuccessModal(
    `⚡ Batch Complete`,
    `
    <div class="card-inner mb-12">
      <div class="text-sm">✅ Success: <b>${results.length}</b> · ❌ Failed: <b>${errors.length}</b></div>
    </div>
    ${results
      .map(
        (r) => `
      <div class="tx-item">
        <div class="tx-meta">
          <div class="tx-addr mono">${sanitize(shortAddr(r.to))}</div>
          <div class="tx-time"><a href="${ARC.explorer}/tx/${r.hash}" target="_blank">${shortHash(r.hash)}</a></div>
        </div>
        <div class="tx-amount pos">-${sanitize(r.amount)} ${sanitize(token)}</div>
      </div>`,
      )
      .join("")}
    ${errors
      .map(
        (e) => `
      <div class="tx-item">
        <div class="tx-meta">
          <div class="tx-addr mono">${sanitize(shortAddr(e.to))}</div>
          <div class="tx-time" style="color:var(--red)">${sanitize(e.error)}</div>
        </div>
        <div class="tx-amount neg">FAILED</div>
      </div>`,
      )
      .join("")}
    <button class="btn btn-secondary btn-full mt-12" onclick="closeModal()">Done</button>
  `,
  );
}
(window as any).doMultiSend = doMultiSend;

function addRecipient() {
  const list = document.getElementById("multi-recipients");
  if (!list) return;
  const row = document.createElement("div");
  row.className = "recipient-row";
  row.innerHTML = `
    <input type="text" placeholder="0x...address" class="field addr" />
    <input type="number" placeholder="Amount" min="0" step="any" class="field amount" />
    <button class="rm-btn" onclick="removeRecipient(this)">×</button>`;
  list.appendChild(row);
  updateMultiCount();
}
(window as any).addRecipient = addRecipient;

function removeRecipient(btn: HTMLElement) {
  const rows = document.querySelectorAll("#multi-recipients .recipient-row");
  if (rows.length > 1) btn.closest(".recipient-row")?.remove();
  updateMultiCount();
}
(window as any).removeRecipient = removeRecipient;

function updateMultiCount() {
  const rows = document.querySelectorAll("#multi-recipients .recipient-row");
  setText("multi-count", rows.length.toString());
  let total = 0;
  rows.forEach((r) => {
    const a = r.querySelectorAll("input")[1] as HTMLInputElement;
    total += parseFloat(a?.value || "0") || 0;
  });
  const token = getActiveToken("multi-token-tabs") ?? "USDC";
  setText("multi-total", total.toFixed(2) + " " + token);
}
(window as any).updateMultiCount = updateMultiCount;
document
  .getElementById("multi-recipients")
  ?.addEventListener("input", updateMultiCount);

// ── QR Payment ─────────────────────────────────────────────
function generateQR() {
  const addr =
    (document.getElementById("qr-addr") as HTMLInputElement)?.value.trim() ??
    "";
  const amount =
    (document.getElementById("qr-amount") as HTMLInputElement)?.value ?? "";
  const msg =
    (document.getElementById("qr-msg") as HTMLInputElement)?.value ?? "";
  const token = getActiveToken("qr-token-tabs") ?? "USDC";

  if (!addr) {
    toast("error", "Enter receiver address");
    return;
  }
  // Fix #11: validate address
  if (!ethers.isAddress(addr)) {
    toast("error", "Invalid wallet address");
    return;
  }

  const data = JSON.stringify({
    to: addr,
    amount,
    token,
    msg,
    chain: "arc-testnet",
  });
  const out = document.getElementById("qr-output");
  if (!out) return;
  out.innerHTML = '<div class="qr-wrap" id="qr-canvas-wrap"></div>';

  QRCode.toString(
    data,
    { type: "svg", width: 160, color: { dark: "#0f1118", light: "#ffffff" } },
    (err, svg) => {
      if (err) {
        out.textContent = "QR error";
        return;
      }
      const wrap = document.getElementById("qr-canvas-wrap");
      if (wrap)
        wrap.innerHTML = `<div style="background:#fff;padding:12px;border-radius:10px;display:inline-block">${svg}</div>`;
    },
  );

  const base = window.location.href.split("?")[0];
  const link = `${base}?to=${encodeURIComponent(addr)}&amount=${encodeURIComponent(amount)}&token=${encodeURIComponent(token)}&msg=${encodeURIComponent(msg)}`;
  const linkBox = document.getElementById("qr-link-box");
  const linkText = document.getElementById("qr-link-text");
  if (linkBox) linkBox.style.display = "block";
  if (linkText) linkText.textContent = link;
}
(window as any).generateQR = generateQR;

function updateQR() {
  if (document.getElementById("qr-canvas-wrap")) generateQR();
}
(window as any).updateQR = updateQR;

// ── Scan QR ────────────────────────────────────────────────
let html5QrCode: Html5Qrcode | null = null;

function switchScan(mode: string) {
  document
    .getElementById("tab-camera")
    ?.classList.toggle("active", mode === "camera");
  document
    .getElementById("tab-image")
    ?.classList.toggle("active", mode === "image");
  const cb = document.getElementById("scan-camera-box");
  const ib = document.getElementById("scan-image-box");
  if (cb) cb.style.display = mode === "camera" ? "block" : "none";
  if (ib) ib.style.display = mode === "image" ? "block" : "none";
  if (mode !== "camera" && html5QrCode) {
    try {
      html5QrCode.stop();
    } catch {
      /* ignore */
    }
  }
}
(window as any).switchScan = switchScan;

function startCamera(): void {
  if (!html5QrCode) html5QrCode = new Html5Qrcode("reader");
  html5QrCode
    .start(
      { facingMode: "environment" },
      { fps: 10, qrbox: { width: 200, height: 200 } },
      (text) => {
        html5QrCode?.stop();
        handleScanResult(text);
      },
      () => {},
    )
    .catch((e) => toast("error", "Camera denied: " + String(e)));
  const btn = document.getElementById(
    "scan-start-btn",
  ) as HTMLButtonElement | null;
  if (btn) {
    btn.textContent = "⏹ Stop Camera";
    btn.onclick = stopCamera;
  }
}
(window as any).startCamera = startCamera;

function stopCamera() {
  try {
    html5QrCode?.stop();
  } catch {
    /* ignore */
  }
  const btn = document.getElementById(
    "scan-start-btn",
  ) as HTMLButtonElement | null;
  if (btn) {
    btn.textContent = "Start Camera";
    btn.onclick = startCamera;
  }
}
(window as any).stopCamera = stopCamera;

function scanImageFile(input: HTMLInputElement): void {
  const file = input.files?.[0];
  if (!file) return;
  if (!html5QrCode) html5QrCode = new Html5Qrcode("reader");
  html5QrCode
    .scanFile(file, true)
    .then((text) => handleScanResult(text))
    .catch(() => toast("error", "Could not read QR from image"));
}
(window as any).scanImageFile = scanImageFile;

// Fix #7: sanitize all user-controlled values before innerHTML
function handleScanResult(text: string) {
  const el = document.getElementById("scan-result");
  if (!el) return;
  try {
    const data = JSON.parse(text);
    // Validate the parsed data
    const safeAddr = typeof data.to === "string" ? sanitize(data.to) : "";
    const safeAmount =
      typeof data.amount === "string" ? sanitize(data.amount) : "";
    const safeToken =
      typeof data.token === "string" ? sanitize(data.token) : "USDC";
    const safeMsg = typeof data.msg === "string" ? sanitize(data.msg) : "";
    // Store safe payload for prefill — use encoded data attribute, not inline JS
    const safePayload = encodeURIComponent(
      JSON.stringify({
        to: data.to,
        amount: data.amount,
        token: data.token,
        msg: data.msg,
      }),
    );
    el.innerHTML = `
      <div class="card-inner mt-12">
        <div class="text-xs text-muted mb-8">QR Decoded ✓</div>
        <div class="mb-8"><span class="text-muted text-xs">To:</span> <span class="mono text-sm fw600">${safeAddr || "(none)"}</span></div>
        ${safeAmount ? `<div class="mb-8"><span class="text-muted text-xs">Amount:</span> <span class="mono fw600">${safeAmount} ${safeToken}</span></div>` : ""}
        ${safeMsg ? `<div class="mb-12"><span class="text-muted text-xs">Msg:</span> <span class="text-sm">${safeMsg}</span></div>` : ""}
        <button class="btn btn-primary btn-full" data-qr-payload="${safePayload}" onclick="prefillFromBtn(this)">Pay Now</button>
      </div>`;
  } catch {
    el.innerHTML = `<div class="card-inner mt-12"><div class="text-xs text-muted mb-4">Raw QR</div><div class="mono text-xs">${sanitize(text)}</div></div>`;
  }
}
(window as any).handleScanResult = handleScanResult;

// Replaces old inline-JSON prefillAndSend — reads from data attribute (safe)
function prefillFromBtn(btn: HTMLButtonElement) {
  try {
    const data = JSON.parse(decodeURIComponent(btn.dataset.qrPayload ?? "{}"));
    prefillAndSend(data);
  } catch {
    toast("error", "Could not parse QR data");
  }
}
(window as any).prefillFromBtn = prefillFromBtn;

function prefillAndSend(data: any): void {
  nav("send");
  const toEl = document.getElementById("send-to") as HTMLInputElement | null;
  const amountEl = document.getElementById(
    "send-amount",
  ) as HTMLInputElement | null;
  const msgEl = document.getElementById("send-msg") as HTMLInputElement | null;
  if (toEl && typeof data.to === "string") toEl.value = data.to;
  if (amountEl && typeof data.amount === "string") amountEl.value = data.amount;
  if (msgEl && typeof data.msg === "string") msgEl.value = data.msg;
  const wantToken = typeof data.token === "string" ? data.token : "USDC";
  document.querySelectorAll("#send-token-tabs .token-tab").forEach((t) => {
    const tab = t as HTMLElement;
    tab.classList.toggle("active", tab.dataset.token === wantToken);
  });
}
(window as any).prefillAndSend = prefillAndSend;

// ── Payment Links ──────────────────────────────────────────
function updateLinkPreview() {
  const el = document.getElementById("gen-link");
  if (!el) return;
  if (!state.address) {
    el.textContent = "Connect wallet first";
    return;
  }
  const amount =
    (document.getElementById("link-amount") as HTMLInputElement)?.value ?? "";
  const msg =
    (document.getElementById("link-msg") as HTMLInputElement)?.value ?? "";
  const token = getActiveToken("link-token-tabs") ?? "USDC";
  const base = window.location.href.split("?")[0];
  let url = `${base}?to=${encodeURIComponent(state.address)}`;
  if (amount) url += `&amount=${encodeURIComponent(amount)}`;
  url += `&token=${encodeURIComponent(token)}`;
  if (msg) url += `&msg=${encodeURIComponent(msg)}`;
  el.textContent = url;
  const wrap = document.getElementById("link-qr-wrap");
  if (wrap) {
    QRCode.toString(url, { type: "svg", width: 120 }, (err, svg) => {
      if (!err && wrap)
        wrap.innerHTML = `<div style="background:#fff;padding:10px;border-radius:10px;display:inline-block">${svg}</div>`;
    });
  }
}
(window as any).updateLinkPreview = updateLinkPreview;

async function savePaymentLink() {
  if (!state.address) {
    requireWallet();
    return;
  }
  const urlEl = document.getElementById("gen-link");
  const url = urlEl?.textContent ?? "";
  if (!url || url === "Connect wallet first") {
    toast("error", "Generate a link first");
    return;
  }
  const amount =
    (document.getElementById("link-amount") as HTMLInputElement)?.value ?? "";
  const msg =
    (document.getElementById("link-msg") as HTMLInputElement)?.value ?? "";
  const token = getActiveToken("link-token-tabs") ?? "USDC";
  const expMs =
    parseInt(
      (document.getElementById("link-exp") as HTMLInputElement)?.value ?? "0",
    ) || 0;
  const link = {
    id: Date.now(),
    url,
    amount,
    token,
    msg,
    active: true,
    createdAt: Date.now(),
    expiresAt: expMs ? Date.now() + expMs : null,
  };
  await fbSave("paymentLinks", link);
  state.paymentLinks.unshift(link);
  renderLinks();
  toast("success", "Payment link saved!");
}
(window as any).savePaymentLink = savePaymentLink;

function renderLinks() {
  const el = document.getElementById("links-list");
  if (!el) return;
  if (!state.paymentLinks.length) {
    el.innerHTML =
      '<div class="empty-state text-xs">No payment links yet</div>';
    return;
  }
  el.innerHTML = state.paymentLinks
    .map((l) => {
      const expired = l.expiresAt && Date.now() > l.expiresAt;
      const status = expired ? "tag-gray" : l.active ? "tag-green" : "tag-gray";
      const statusText = expired ? "Expired" : l.active ? "Active" : "Inactive";
      const safeUrl = sanitize(l.url ?? "");
      return `<div class="card-inner mb-8">
      <div class="flex justify-between items-center mb-8">
        <span class="fw600 text-sm">${l.amount ? sanitize(l.amount) + " " + sanitize(l.token) : "Any amount"}</span>
        <span class="tag ${status}">${statusText}</span>
      </div>
      ${l.msg ? `<div class="text-xs text-muted mb-8">${sanitize(l.msg)}</div>` : ""}
      <div class="link-box" style="padding:8px">
        <span class="link-text truncate" style="font-size:11px">${safeUrl}</span>
        <button class="copy-btn" data-copy="${safeUrl}" onclick="copyVal(this.dataset.copy)">Copy</button>
      </div>
    </div>`;
    })
    .join("");
}
(window as any).renderLinks = renderLinks;

// ── Scheduled Payments ─────────────────────────────────────
async function doAddSchedule() {
  if (!requireWallet()) return;
  const to =
    (document.getElementById("sched-to") as HTMLInputElement)?.value.trim() ??
    "";
  const amount =
    (
      document.getElementById("sched-amount") as HTMLInputElement
    )?.value.trim() ?? "";
  const msg =
    (document.getElementById("sched-msg") as HTMLInputElement)?.value.trim() ??
    "";
  const freq =
    (document.getElementById("sched-freq") as HTMLInputElement)?.value ??
    "once";
  const date =
    (document.getElementById("sched-date") as HTMLInputElement)?.value ?? "";
  const token = getActiveToken("sched-token-tabs") ?? "USDC";

  // Fix #2: validate address
  if (!ethers.isAddress(to)) {
    toast("error", "Invalid recipient address");
    return;
  }
  if (!amount || parseFloat(amount) <= 0) {
    toast("error", "Enter a valid amount");
    return;
  }


const tomorrow = new Date();
tomorrow.setDate(tomorrow.getDate() + 1);
tomorrow.setHours(0, 0, 0, 0);
const tomorrowTs = tomorrow.getTime();

const selectedTs = date ? new Date(date).getTime() : 0;
if (!date || selectedTs < tomorrowTs) {
  toast("error", "Start date must be at least tomorrow");
  return;
}

  // Approve relayer address để server có thể transferFrom khi đến hạn
  const RELAYER_ADDRESS = import.meta.env.VITE_RELAYER_ADDRESS as string;
  if (!RELAYER_ADDRESS) {
    toast("error", "Relayer not configured"); return;
  }
  try {
    if (!state.signer) {
      state.signer = await state.provider!.getSigner();
    }
    await ensureArcNetwork();
    await ensureRelayerApproval(state.signer, RELAYER_ADDRESS);
  } catch (e: any) {
    toast("error", e?.message?.includes("cancelled") ? "Approval cancelled — schedule not created" : (e?.message ?? "Approval failed"));
    return;
  }


const startTs = date ? new Date(date).getTime() : tomorrow.getTime();
  const sched = {
    id: Date.now(),
    to,
    amount,
    token,
    msg,
    freq,
    nextRunAt: startTs,
    active: true,
    createdAt: Date.now(),
  };
  await fbSave("schedules", sched);
  state.schedules.unshift(sched);
  renderSchedules();
  clearFields(["sched-to", "sched-amount", "sched-msg", "sched-date"]);
  toast("success", "Payment scheduled!");
  renderHomeSchedule();
}
(window as any).doAddSchedule = doAddSchedule;

function renderSchedules() {
  const el = document.getElementById("schedule-list");
  if (!el) return;
  if (!state.schedules.length) {
    el.innerHTML =
      '<div class="empty-state text-xs">No scheduled payments</div>';
    return;
  }
  el.innerHTML = state.schedules
    .map(
      (s) => `
    <div class="schedule-item">
      <div class="schedule-dot" style="background:${s.active ? "var(--green)" : "var(--text3)"}"></div>
      <div style="flex:1;padding-left:8px">
        <div class="fw600 text-sm">${sanitize(shortAddr(s.to))}</div>
        <div class="text-xs text-muted mt-4">${sanitize(cap(s.freq))} · ${sanitize(s.amount)} ${sanitize(s.token)} · Next: ${fmtDate(s.nextRunAt)}</div>
      </div>
      <div class="flex gap-8">
        <button class="btn ${s.active ? "btn-danger" : "btn-success"} btn-sm" onclick="toggleSchedule(${Number(s.id)})">${s.active ? "Pause" : "Resume"}</button>
        <button class="btn btn-secondary btn-sm" onclick="deleteSchedule(${Number(s.id)})">🗑</button>
      </div>
    </div>`,
    )
    .join("");
}
(window as any).renderSchedules = renderSchedules;

async function toggleSchedule(id: number) {
  const s = state.schedules.find((x) => x.id === id);
  if (!s) return;
  s.active = !s.active;
  await fbSave("schedules", s);
  renderSchedules();
  renderHomeSchedule();
}
(window as any).toggleSchedule = toggleSchedule;

async function deleteSchedule(id: number) {
  state.schedules = state.schedules.filter((x) => x.id !== id);
  await fbDelete("schedules", id);
  renderSchedules();
  renderHomeSchedule();
}
(window as any).deleteSchedule = deleteSchedule;

// Server-side scheduler (server.ts) tự động chạy via ERC-8183 relayer.
// Client không cần làm gì thêm sau khi tạo schedule + ký approve.
function runDueSchedules() { /* no-op: handled by server */ }
(window as any).runDueSchedules = runDueSchedules;

function nextRunTime(freq: string, from: number): number {
  const d = new Date(from);
  if (freq === "daily") d.setDate(d.getDate() + 1);
  if (freq === "weekly") d.setDate(d.getDate() + 7);
  if (freq === "monthly") d.setMonth(d.getMonth() + 1);
  return d.getTime();
}
(window as any).nextRunTime = nextRunTime;

function renderHomeSchedule() {
  const el = document.getElementById("home-schedule-list");
  if (!el) return;
  const active = state.schedules.filter((s) => s.active).slice(0, 4);
  if (!active.length) {
    el.innerHTML =
      '<div class="empty-state text-xs">No upcoming payments</div>';
    return;
  }
  el.innerHTML = active
    .map(
      (s) => `
    <div class="schedule-item">
      <div class="schedule-dot" style="background:var(--amber)"></div>
      <div style="flex:1;padding-left:8px">
        <div class="fw600 text-sm">${sanitize(s.amount)} ${sanitize(s.token)} → ${sanitize(shortAddr(s.to))}</div>
        <div class="text-xs text-muted mt-4">${sanitize(cap(s.freq))} · ${fmtDate(s.nextRunAt)}</div>
      </div>
    </div>`,
    )
    .join("");
}
(window as any).renderHomeSchedule = renderHomeSchedule;

// ── Contacts ───────────────────────────────────────────────
// Fix #12: guard null element
function renderContacts() {
  const el = document.getElementById("contacts-grid");
  if (!el) return;
  const searchEl = document.getElementById(
    "contact-search",
  ) as HTMLInputElement | null;
  const q = searchEl?.value.toLowerCase() ?? "";
  const filtered = state.contacts.filter(
    (c) =>
      !q ||
      c.name.toLowerCase().includes(q) ||
      c.address.toLowerCase().includes(q),
  );
  if (!filtered.length) {
    el.innerHTML =
      '<div class="empty-state text-xs" style="grid-column:span 2">No contacts yet</div>';
    return;
  }
  const colors = [
    "rgba(108,99,255,.15)",
    "rgba(0,229,195,.1)",
    "rgba(255,181,71,.1)",
    "rgba(34,217,138,.1)",
    "rgba(255,92,122,.1)",
  ];
  const textColors = [
    "var(--p2)",
    "var(--teal)",
    "var(--amber)",
    "var(--green)",
    "var(--red)",
  ];
  el.innerHTML = filtered
    .map(
      (c, i) => `
    <div class="contact-card" onclick="showContact(${Number(c.id)})">
      <div class="avatar" style="background:${colors[i % 5]};color:${textColors[i % 5]}">${sanitize(c.name.slice(0, 2).toUpperCase())}</div>
      <div style="min-width:0">
        <div class="fw600 text-sm">${sanitize(c.name)}</div>
        <div class="text-xs text-muted mono truncate">${sanitize(shortAddr(c.address))}</div>
        ${c.tag ? `<div class="mt-4"><span class="tag tag-p" style="font-size:10px">#${sanitize(c.tag)}</span></div>` : ""}
      </div>
    </div>`,
    )
    .join("");
}
(window as any).renderContacts = renderContacts;

// Fix #8: avoid XSS in onclick by using data-id attribute
function showContact(id: number) {
  const c = state.contacts.find((x) => x.id === id);
  const det = document.getElementById("contact-detail-card");
  if (!c || !det) return;

  // Tính từ state.history — không phụ thuộc field totalSent/totalReceived trong Firebase
  const addr = c.address.toLowerCase();
  const totalSent = state.history
    .filter((h) => h.type === "sent" && h.to?.toLowerCase() === addr)
    .reduce((sum, h) => sum + parseFloat(h.amount || "0"), 0);
  const totalReceived = state.history
    .filter((h) => h.type === "received" && h.from?.toLowerCase() === addr)
    .reduce((sum, h) => sum + parseFloat(h.amount || "0"), 0);

  det.innerHTML = `
    <div class="section-title">Contact Detail</div>
    <div class="text-center" style="padding:20px 0 16px">
      <div class="avatar" style="width:60px;height:60px;font-size:20px;margin:0 auto 12px;background:rgba(108,99,255,.15);color:var(--p2)">${sanitize(c.name.slice(0, 2).toUpperCase())}</div>
      <div class="fw700" style="font-size:16px">${sanitize(c.name)}</div>
      <div class="text-muted text-xs mono mt-4">${sanitize(c.address)}</div>
    </div>
    <div class="card-inner mb-8 flex justify-between"><span class="text-muted text-sm">Total Sent</span><span class="fw600 mono" style="color:var(--red)">-${totalSent.toFixed(2)} USDC</span></div>
    <div class="card-inner mb-16 flex justify-between"><span class="text-muted text-sm">Total Received</span><span class="fw600 mono" style="color:var(--green)">+${totalReceived.toFixed(2)} USDC</span></div>
    <div class="flex gap-8">
      <button class="btn btn-primary" style="flex:1" data-addr="${sanitize(c.address)}" onclick="nav('send');(document.getElementById('send-to')).value=this.dataset.addr">Send</button>
      <button class="btn btn-secondary" style="flex:1" onclick="deleteContact(${Number(c.id)})">Delete</button>
    </div>`;
}
(window as any).showContact = showContact;

function openAddContact() {
  showModal(
    "Add Contact",
    `
    <div class="field"><label>Name</label><input type="text" id="nc-name" placeholder="Alice" maxlength="50"/></div>
    <div class="field"><label>Wallet Address</label><input type="text" id="nc-addr" placeholder="0x..." maxlength="42"/></div>
    <div class="field"><label>Tag</label><select id="nc-tag"><option value="">None</option><option value="work">work</option><option value="personal">personal</option><option value="rent">rent</option></select></div>
    <button class="btn btn-primary btn-full" onclick="addContact()">Add Contact</button>`,
  );
}
(window as any).openAddContact = openAddContact;

async function addContact() {
  const name =
    (document.getElementById("nc-name") as HTMLInputElement)?.value.trim() ??
    "";
  const addr =
    (document.getElementById("nc-addr") as HTMLInputElement)?.value.trim() ??
    "";
  const tag =
    (document.getElementById("nc-tag") as HTMLInputElement)?.value ?? "";
  if (!name) {
    toast("error", "Enter a name");
    return;
  }
  if (!ethers.isAddress(addr)) {
    toast("error", "Enter a valid wallet address");
    return;
  }
  // Prevent duplicate
  if (
    state.contacts.some((c) => c.address.toLowerCase() === addr.toLowerCase())
  ) {
    toast("error", "Contact already exists");
    return;
  }
  const contact = {
    id: Date.now(),
    name,
    address: addr,
    tag,
    totalSent: 0,
    totalReceived: 0,
  };
  await fbSave("contacts", contact);
  state.contacts.push(contact);
  renderContacts();
  updateContactDatalist();
  closeModal();
  toast("success", "Contact added!");
}
(window as any).addContact = addContact;

async function deleteContact(id: number) {
  state.contacts = state.contacts.filter((x) => x.id !== id);
  await fbDelete("contacts", id);
  renderContacts();
  const det = document.getElementById("contact-detail-card");
  if (det)
    det.innerHTML =
      '<div class="section-title">Contact Detail</div><div class="empty-state text-xs">Select a contact</div>';
}
(window as any).deleteContact = deleteContact;

function updateContactDatalist() {
  const dl = document.getElementById("contact-datalist");
  if (dl)
    dl.innerHTML = state.contacts
      .map(
        (c) =>
          `<option value="${sanitize(c.address)}">${sanitize(c.name)} · ${sanitize(shortAddr(c.address))}</option>`,
      )
      .join("");
}
(window as any).updateContactDatalist = updateContactDatalist;

function renderSplitParticipants() {
  const el = document.getElementById("split-participants");
  if (!el) return;
  const list = state.contacts.length
    ? state.contacts
    : [
       
      ];
  el.innerHTML = list
    .slice(0, 8)
    .map(
      (c) => `
    <div class="split-person">
      <div class="flex items-center gap-8">
        <div class="split-check on" id="sp-${Number(c.id)}" onclick="toggleSplit(this)">✓</div>
        <span class="text-sm">${sanitize(c.name)} · <span class="mono text-xs">${sanitize(shortAddr(c.address))}</span></span>
      </div>
      <span class="fw600 mono text-sm" id="sph-${Number(c.id)}">0 USDC</span>
    </div>`,
    )
    .join("");
}
(window as any).renderSplitParticipants = renderSplitParticipants;

// ── Split Bill ─────────────────────────────────────────────
function calcSplit() {
  const total =
    parseFloat(
      (document.getElementById("split-total") as HTMLInputElement)?.value ??
        "0",
    ) || 0;
  const checked = document.querySelectorAll(
    "#split-participants .split-check.on",
  );
  const each = checked.length ? (total / checked.length).toFixed(2) : "0.00";
  setText("split-each", each + " USDC");
  document
    .querySelectorAll("#split-participants .split-person")
    .forEach((row) => {
      const chk = row.querySelector(".split-check") as HTMLElement | null;
      const valEl = row.querySelector('[id^="sph-"]');
      if (valEl && chk)
        valEl.textContent = chk.classList.contains("on") ? each + " USDC" : "—";
    });
}
(window as any).calcSplit = calcSplit;

function toggleSplit(el: HTMLElement) {
  el.classList.toggle("on");
  el.textContent = el.classList.contains("on") ? "✓" : "";
  calcSplit();
}
(window as any).toggleSplit = toggleSplit;

async function doSplitBill() {
  if (!requireWallet()) return;
  const total =
    (document.getElementById("split-total") as HTMLInputElement)?.value ?? "";
  const desc =
    (document.getElementById("split-desc") as HTMLInputElement)?.value.trim() ||
    "Split bill";
  if (!total || parseFloat(total) <= 0) {
    toast("error", "Enter a valid total amount");
    return;
  }
  const checked = document.querySelectorAll("#split-participants .split-check.on");
  if (!checked.length) {
    toast("error", "Select at least one participant");
    return;
  }
  const each = (parseFloat(total) / checked.length).toFixed(2);

  const participantIds = [...checked].map((c) =>
    parseInt((c as HTMLElement).id.replace("sp-", ""))
  );
  const realParticipants = state.contacts.filter(
    (c) => participantIds.includes(c.id) && ethers.isAddress(c.address)
  );

  const billId = Date.now();
  const bill = {
    id: billId,
    desc,
    total,
    each,
    count: checked.length,
    ts: Date.now(),
    settled: false,
    createdBy: state.address!.toLowerCase(),
    // Mỗi participant có trạng thái paid riêng
    participants: realParticipants.map((c) => ({
      name: c.name,
      address: c.address.toLowerCase(),
      paid: false,
      paidAt: null,
      txHash: null,
    })),
  };

  await fbSave("splitBills", bill);
  state.splitBills.unshift(bill);
  renderSplitHistory();

  const creatorShort = shortAddr(state.address);
  const writePromises = realParticipants.map(async (c) => {
    const participantAddr = c.address.toLowerCase();
    const billRef = doc(db, "users", participantAddr, "splitBills", String(billId));
    await setDoc(billRef, {
      ...bill,
      ownerAddress: participantAddr,
      updatedAt: Date.now(),
    });
    const notifId = Date.now() + Math.floor(Math.random() * 1000);
    const notifRef = doc(db, "users", participantAddr, "notifications", String(notifId));
    await setDoc(notifRef, {
      id: notifId,
      text: `💸 ${creatorShort} require you to pay ${each} USDC to "${desc}"`,
      time: Date.now(),
      read: false,
      ownerAddress: participantAddr,
      type: "split_request",
      billId,
      from: state.address!.toLowerCase(),
      amount: each,
      updatedAt: Date.now(),
    });
  });

  try {
    await Promise.all(writePromises);
    await pushNotif(`Split bill "${desc}" sent ${realParticipants.length} person`);
  } catch (e) {
    console.error("Failed to notify participants", e);
    toast("error", "Some notifications failed to send.");
  }

  showSuccessModal(
    "✂️ Split Bill Created",
    `
    <div class="card-inner mb-12"><div class="text-xs text-muted mb-4">Total</div><div class="fw700 mono">${sanitize(total)} USDC</div></div>
    <div class="card-inner mb-12"><div class="text-xs text-muted mb-4">Per Person</div><div class="fw700 mono" style="color:var(--p2)">${sanitize(each)} USDC</div></div>
    <div class="card-inner mb-12"><div class="text-xs text-muted mb-4">Participants</div><div class="fw700">${checked.length} people</div></div>
    ${realParticipants.length ? `<div class="card-inner mb-16"><div class="text-xs text-muted mb-4">Announced</div><div class="fw600 text-sm">${realParticipants.map((c) => sanitize(c.name)).join(", ")}</div></div>` : ""}
    <button class="btn btn-secondary btn-full" onclick="closeModal()">Done</button>`
  );
}
(window as any).doSplitBill = doSplitBill;

function renderSplitHistory() {
  const el = document.getElementById("split-history-list");
  if (!el) return;
  if (!state.splitBills.length) {
    el.innerHTML = '<div class="empty-state text-xs">No split bills yet</div>';
    return;
  }

  el.innerHTML = state.splitBills
    .map((b) => {
      const isOwner =
        !b.createdBy ||
        b.createdBy.toLowerCase() === state.address?.toLowerCase();

      const paidCount = (b.participants ?? []).filter((p: any) => p.paid).length;
      const totalCount = b.participants?.length ?? b.count ?? 0;

      if (isOwner) {
        const allSettled = totalCount > 0 && paidCount === totalCount;
        return `
        <div class="tx-item" style="cursor:pointer" onclick="showSplitDetail('${b.id}')">
          <div class="tx-icon" style="background:rgba(255,181,71,.1);color:var(--amber);font-size:16px">✂️</div>
          <div class="tx-meta">
            <div class="tx-addr fw600">${sanitize(b.desc)}</div>
            <div class="tx-msg text-xs text-muted">
              You create · ${sanitize(b.each)} USDC/person
              ${totalCount ? `· <span style="color:${paidCount === totalCount ? "var(--green)" : "var(--amber)"}">${paidCount}/${totalCount} paid</span>` : ""}
            </div>
            <div class="tx-time">${fmtDate(b.ts)}</div>
          </div>
          <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px">
            <span class="tag ${allSettled ? "tag-green" : "tag-amber"}">${allSettled ? "Settled" : "Pending"}</span>
            <span class="text-xs text-muted">Total: ${sanitize(b.total)} USDC</span>
          </div>
        </div>`;
      }

      // Phía người được chia — tìm trạng thái paid của chính mình
      const myEntry = (b.participants ?? []).find(
        (p: any) => p.address?.toLowerCase() === state.address?.toLowerCase()
      );
      const iMePaid = myEntry?.paid ?? b.settled ?? false;
      const fromName = sanitize(shortAddr(b.createdBy));

      return `
      <div class="tx-item" style="cursor:pointer;border-left:3px solid var(--p2);padding-left:10px" onclick="showSplitDetail('${b.id}')">
        <div class="tx-icon" style="background:rgba(108,99,255,.15);color:var(--p2);font-size:16px">📩</div>
        <div class="tx-meta">
          <div class="tx-addr fw600">${sanitize(b.desc)}</div>
          <div class="tx-msg text-xs text-muted">
            From <span class="fw600" style="color:var(--p2)">${fromName}</span>
            · <span class="fw600" style="color:${iMePaid ? "var(--green)" : "var(--red)"}">${iMePaid ? "Paid" : "Payment required"} ${sanitize(b.each)} USDC</span>
          </div>
          <div class="tx-time">${fmtDate(b.ts)}</div>
        </div>
        <span class="tag ${iMePaid ? "tag-green" : "tag-p"}">${iMePaid ? "Paid" : "Not yet paid"}</span>
      </div>`;
    })
    .join("");
}
(window as any).renderSplitHistory = renderSplitHistory;

function showSplitDetail(billId: string | number) {
  const b = state.splitBills.find((x) => String(x.id) === String(billId));
  if (!b) return;

  const isOwner =
    !b.createdBy ||
    b.createdBy.toLowerCase() === state.address?.toLowerCase();

  const participants: any[] = b.participants ?? [];
  const paidCount = participants.filter((p) => p.paid).length;

  // Render danh sách participants
  const participantRows = participants.length
    ? participants
        .map((p) => {
          const isMe =
            p.address?.toLowerCase() === state.address?.toLowerCase();
          return `
          <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--border)">
            <div style="display:flex;align-items:center;gap:10px">
              <div style="width:32px;height:32px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;
                background:${p.paid ? "rgba(34,217,138,.15)" : "rgba(108,99,255,.15)"};
                color:${p.paid ? "var(--green)" : "var(--p2)"}">
                ${p.paid ? "✓" : sanitize((p.name ?? "?").slice(0, 2).toUpperCase())}
              </div>
              <div>
                <div class="fw600 text-sm">${sanitize(p.name ?? shortAddr(p.address))}${isMe ? ' <span style="color:var(--p2);font-size:10px">(you)</span>' : ""}</div>
                <div class="mono text-xs text-muted">${sanitize(shortAddr(p.address))}</div>
              </div>
            </div>
            <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px">
              ${
                p.paid
                  ? `<span class="tag tag-green">Paid</span>
                     ${p.txHash ? `<a href="${ARC.explorer}/tx/${p.txHash}" target="_blank" class="mono text-xs" style="color:var(--text3)">${shortHash(p.txHash)}</a>` : ""}`
                  : isMe && !isOwner
                  ? `<button class="btn btn-primary btn-sm" style="font-size:11px"
                       onclick="closeModal();payBackSplit('${sanitize(b.createdBy)}','${sanitize(b.each)}','${sanitize(String(b.id))}','${sanitize(b.desc)}')">
                       Paid ${sanitize(b.each)} USDC
                     </button>`
                  : `<span class="tag tag-amber">Not yet paid</span>`
              }
            </div>
          </div>`;
        })
        .join("")
    : `<div class="empty-state text-xs">No participant information available.</div>`;

  const progressPct =
    participants.length > 0
      ? Math.round((paidCount / participants.length) * 100)
      : 0;

  showModal(
    `✂️ ${sanitize(b.desc)}`,
    `
    <!-- Tổng quan -->
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:16px">
      <div class="card-inner" style="text-align:center">
        <div class="text-xs text-muted mb-4">Total</div>
        <div class="fw700 mono">${sanitize(b.total)} USDC</div>
      </div>
      <div class="card-inner" style="text-align:center">
        <div class="text-xs text-muted mb-4">Each person</div>
        <div class="fw700 mono" style="color:var(--p2)">${sanitize(b.each)} USDC</div>
      </div>
      <div class="card-inner" style="text-align:center">
        <div class="text-xs text-muted mb-4">Paid</div>
        <div class="fw700 mono" style="color:${paidCount === participants.length && participants.length > 0 ? "var(--green)" : "var(--amber)"}">${paidCount}/${participants.length}</div>
      </div>
    </div>

    <!-- Progress bar -->
    ${
      participants.length > 0
        ? `<div style="margin-bottom:16px">
            <div style="display:flex;justify-content:space-between;margin-bottom:6px">
              <span class="text-xs text-muted">Payment collection progress</span>
              <span class="text-xs fw600" style="color:var(--green)">${progressPct}%</span>
            </div>
            <div style="background:var(--bg3);border-radius:99px;height:6px;overflow:hidden">
              <div style="height:100%;width:${progressPct}%;background:linear-gradient(90deg,var(--p),var(--teal));border-radius:99px;transition:width .4s"></div>
            </div>
          </div>`
        : ""
    }

    <!-- Danh sách participants -->
    <div class="section-title mb-8">List</div>
    <div style="max-height:280px;overflow-y:auto">
      ${participantRows}
    </div>

    <div class="text-xs text-muted mt-12">${fmtDate(b.ts)}</div>
    <button class="btn btn-secondary btn-full mt-12" onclick="closeModal()">Close</button>
  `
  );
}
(window as any).showSplitDetail = showSplitDetail;

async function payBackSplit(
  toAddr: string,
  amount: string,
  billId: string,
  desc: string
) {
  if (!requireWallet()) return;

  const confirmed = await Swal.fire({
    title: `Paid ${amount} USDC?`,
    text: `To: ${desc}`,
    icon: "question",
    showCancelButton: true,
    confirmButtonText: "Comfirm",
    cancelButtonText: "Cancel",
    background: "#0f1118",
    color: "#eef0ff",
    confirmButtonColor: "#6c63ff",
  });
  if (!confirmed.isConfirmed) return;

  try {
    const tx = await sendOnChain(toAddr, amount, "USDC", `Split: ${desc}`);
    await refreshBalances();

    // Cập nhật paid=true cho chính mình trong participants[]
    const bill = state.splitBills.find((b) => String(b.id) === String(billId));
    if (bill) {
      const me = (bill.participants ?? []).find(
        (p: any) => p.address?.toLowerCase() === state.address?.toLowerCase()
      );
      if (me) {
        me.paid = true;
        me.paidAt = Date.now();
        me.txHash = tx.hash;
      }
      bill.settled = (bill.participants ?? []).every((p: any) => p.paid);

      // Cập nhật Firestore của mình
      await fbSave("splitBills", bill);

      // Cập nhật Firestore của người tạo bill
      try {
        const ownerBillRef = doc(
          db,
          "users",
          toAddr.toLowerCase(),
          "splitBills",
          String(billId)
        );
        await setDoc(ownerBillRef, { participants: bill.participants, settled: bill.settled, updatedAt: Date.now() }, { merge: true });
      } catch { /* non-critical */ }
    }

    await addToHistory({
      hash: tx.hash,
      from: state.address!,
      to: toAddr,
      amount,
      token: "USDC",
      type: "sent",
      msg: `Split: ${desc}`,
      ts: Date.now(),
    });

    await pushNotif(`Paid ${amount} USDC to "${desc}"`);
    renderSplitHistory();

    showSuccessModal(
      "✅ Payment successful!",
      `
      <div class="card-inner mb-12">
        <div class="text-xs text-muted mb-4">Amout</div>
        <div class="fw700 mono" style="font-size:20px;color:var(--green)">${sanitize(amount)} USDC</div>
      </div>
      <div class="card-inner mb-16">
        <div class="text-xs text-muted mb-4">Transaction</div>
        <a href="${ARC.explorer}/tx/${tx.hash}" target="_blank" class="mono text-xs">${shortHash(tx.hash)}</a>
      </div>
      <button class="btn btn-secondary btn-full" onclick="closeModal()">Done</button>`
    );
  } catch (e: unknown) {
    toast("error", e instanceof Error ? e.message : "Transaction failed");
  }
}
(window as any).payBackSplit = payBackSplit;
// ── Transaction History ────────────────────────────────────
// Fix #14: write to Firestore FIRST, then update state
async function addToHistory(tx: TxHistory) {
  if (!state.address) return;
  const docId = tx.hash
    ? `${tx.hash.replace(/[^a-zA-Z0-9]/g, "")}_${tx.type}_${tx.token}`
    : `tx_${tx.ts}_${Math.random().toString(36).slice(2)}`;

  // ── 1. Lưu cho ví hiện tại ────────────────────────────────
  try {
    await setDoc(
      doc(db, "users", state.address.toLowerCase(), "history", docId),
      { ...tx, ownerAddress: state.address.toLowerCase(), updatedAt: Date.now() },
      { merge: true },
    );
    const key = `${tx.hash}-${tx.type}-${tx.token}`;
    const exists = state.history.some((h) => `${h.hash}-${h.type}-${h.token}` === key);
    if (!exists) {
      state.history.unshift(tx);
      updateHistoryStats();
    }
    renderHomeTx();
    renderHistory();
  } catch (e) {
    console.error("addToHistory error", e);
    state.history.unshift(tx);
    renderHomeTx();
    renderHistory();
  }

  // ── 2. Lưu received cho ví đối phương + cập nhật totalReceived contact ──
  if (tx.type === "sent" && tx.to && ethers.isAddress(tx.to)) {
    const receiverAddr = tx.to.toLowerCase();
    const receiverDocId = tx.hash
      ? `${tx.hash.replace(/[^a-zA-Z0-9]/g, "")}_received_${tx.token}`
      : `tx_${tx.ts}_recv_${Math.random().toString(36).slice(2)}`;
    const receiverTx: TxHistory = { ...tx, type: "received", ownerAddress: receiverAddr };
    try {
      await setDoc(
        doc(db, "users", receiverAddr, "history", receiverDocId),
        { ...receiverTx, ownerAddress: receiverAddr, updatedAt: Date.now() },
        { merge: true },
      );
    } catch (e) {
      console.error("addToHistory receiver error", e);
    }

    // Cập nhật totalReceived cho contact người nhận trong danh sách của mình
    const receiverContact = state.contacts.find(
      (c: any) => c.address.toLowerCase() === receiverAddr,
    );
    if (receiverContact) {
      receiverContact.totalReceived = (receiverContact.totalReceived || 0) + parseFloat(tx.amount);
      await fbSave("contacts", receiverContact);
    }
  }

  // ── 3. Cập nhật totalReceived cho contact người gửi (khi mình nhận) ──
  if (tx.type === "received" && tx.from && ethers.isAddress(tx.from)) {
    const senderContact = state.contacts.find(
      (c: any) => c.address.toLowerCase() === tx.from!.toLowerCase(),
    );
    if (senderContact) {
      senderContact.totalReceived = (senderContact.totalReceived || 0) + parseFloat(tx.amount);
      await fbSave("contacts", senderContact);
    }
  }
}
(window as any).addToHistory = addToHistory;


async function getLogsChunked(
  provider: ethers.JsonRpcProvider,
  filter: any,
  fromBlock: number,
  latest: number,
): Promise<ethers.Log[]> {
  const CHUNK = 8000;
  const all: ethers.Log[] = [];
  for (let start = fromBlock; start <= latest; start += CHUNK) {
    const end = Math.min(start + CHUNK - 1, latest);
    try {
      const logs = await provider.getLogs({
        ...filter,
        fromBlock: start,
        toBlock: end,
      });
      all.push(...logs);
    } catch (e: any) {
      console.warn(`getLogs chunk ${start}-${end} failed:`, e?.message);
    }
  }
  return all;
}
(window as any).getLogsChunked = getLogsChunked;

async function loadHistory(): Promise<void> {
  if (!requireWallet()) return;
  const btn = document.getElementById("load-history-btn") as HTMLButtonElement | null;
  setLoading(btn, true, "Loading…");
  try {
    const cached = await fbLoadAll("history");
    state.history = dedupeHistory(cached);
    renderHistory();
    renderHomeTx();
    updateHistoryStats();
    buildAnalytics();
    toast("success", `Loaded ${cached.length} transactions`);
  } catch (e: unknown) {
    toast("error", e instanceof Error ? e.message : "Failed to load history");
  } finally {
    setLoading(btn, false, "Load from Chain");
  }
}
(window as any).loadHistory = loadHistory;

async function backfillHistoryOwner(): Promise<void> {
  if (!state.address) return;
  try {
    const snap = await getDocs(userCol("history"));
    const needsFix = snap.docs.filter((d) => !d.data().ownerAddress);
    if (!needsFix.length) return;
    const CHUNK = 400;
    for (let i = 0; i < needsFix.length; i += CHUNK) {
      const batch = writeBatch(db);
      needsFix.slice(i, i + CHUNK).forEach((d) => {
        batch.set(
          d.ref,
          { ownerAddress: state.address!.toLowerCase(), updatedAt: Date.now() },
          { merge: true },
        );
      });
      await batch.commit();
    }
    console.log(`Backfilled ${needsFix.length} history docs`);
  } catch (e) {
    console.error("backfillHistoryOwner error", e);
  }
}
(window as any).backfillHistoryOwner = backfillHistoryOwner;

async function loadHistoryHome(): Promise<void> {
  if (!state.address) return;
  const btn = document.getElementById("load-history-btn") as HTMLButtonElement | null;
  setLoading(btn, true, "Loading…");
  try {
    const cached = await fbLoadAll("history");
    state.history = dedupeHistory(cached);
    renderHistory();
    renderHomeTx();
    updateHistoryStats();
    buildAnalytics();
  } catch (e) {
    console.error("loadHistoryHome error", e);
  } finally {
    setLoading(btn, false, "Load from Chain");
  }
}
(window as any).loadHistoryHome = loadHistoryHome;

function dedupeHistory(txs: TxHistory[]): TxHistory[] {
  const seen = new Set<string>();
  return txs
    .filter((t) => {
      const key = `${t.hash}-${t.type}-${t.token}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort(
      (a, b) => (b.blockNumber ?? b.ts ?? 0) - (a.blockNumber ?? a.ts ?? 0),
    );
}
(window as any).dedupeHistory = dedupeHistory;

function updateHistoryStats(): void {
  const sent = state.history
    .filter((t) => t.type === "sent")
    .reduce((s, t) => s + parseFloat(t.amount), 0);
  const recv = state.history
    .filter((t) => t.type === "received")
    .reduce((s, t) => s + parseFloat(t.amount), 0);
  setText("home-sent", sent.toFixed(2) + " USDC");
  setText("home-recv", recv.toFixed(2) + " USDC");
}
(window as any).updateHistoryStats = updateHistoryStats;

async function fetchChainHistory(): Promise<TxHistory[]> {
  if (!state.address) throw new Error("Wallet not connected");
  const rpc = new ethers.JsonRpcProvider(ARC.rpc);
  const latest = await rpc.getBlockNumber();

  const RANGE = 100000;
  const fromBlock = Math.max(0, latest - RANGE);

  const results: TxHistory[] = [];
  const iface = new ethers.Interface(ERC20_ABI);
  const transferTopic = iface.getEvent("Transfer")!.topicHash;
  const user = ethers.getAddress(state.address);
  const userTopic = ethers.zeroPadValue(user, 32);

  // Cache block timestamp để tránh gọi RPC quá nhiều
  const blockTimes = new Map<number, number>();
  async function getBlockTime(n: number): Promise<number> {
    if (blockTimes.has(n)) return blockTimes.get(n)!;
    const b = await rpc.getBlock(n).catch(() => null);
    const t = b ? Number(b.timestamp) * 1000 : Date.now();
    blockTimes.set(n, t);
    return t;
  }

  for (const token of ["USDC", "EURC"] as const) {
    const addr = token === "USDC" ? ARC.contracts.USDC : ARC.contracts.EURC;
    const contract = new ethers.Contract(addr, ERC20_ABI, rpc);
    const dec = Number(await contract.decimals().catch(() => 6));

    const sentLogs = await getLogsChunked(
      rpc,
      { address: addr, topics: [transferTopic, userTopic, null] },
      fromBlock, latest,
    );

    const recvLogs = await getLogsChunked(
      rpc,
      { address: addr, topics: [transferTopic, null, userTopic] },
      fromBlock, latest,
    );

    for (const log of sentLogs) {
      const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
      if (!parsed) continue;
      const fromAddr: string = parsed.args[0];
      const toAddr: string = parsed.args[1];
      if (fromAddr.toLowerCase() !== user.toLowerCase()) continue; // ← FIX BUG 1
      if (fromAddr.toLowerCase() === toAddr.toLowerCase()) continue;
      results.push({
        hash: log.transactionHash,
        from: fromAddr,
        to: toAddr,
        amount: Number(ethers.formatUnits(parsed.args[2], dec)).toFixed(2),
        token,
        type: "sent",
        blockNumber: log.blockNumber,
        ts: await getBlockTime(log.blockNumber), // ← FIX BUG 2
      });
    }

    for (const log of recvLogs) {
      const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
      if (!parsed) continue;
      const fromAddr: string = parsed.args[0];
      const toAddr: string = parsed.args[1];
      if (fromAddr.toLowerCase() === toAddr.toLowerCase()) continue;
      if (fromAddr.toLowerCase() === user.toLowerCase()) continue;
      results.push({
        hash: log.transactionHash,
        from: fromAddr,
        to: toAddr,
        amount: Number(ethers.formatUnits(parsed.args[2], dec)).toFixed(2),
        token,
        type: "received",
        blockNumber: log.blockNumber,
        ts: await getBlockTime(log.blockNumber), // ← FIX BUG 2
      });
    }
  }

  const seen = new Set<string>();
  return results
    .filter((t) => {
      const key = `${t.hash}-${t.type}-${t.token}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => (b.blockNumber ?? 0) - (a.blockNumber ?? 0));
}
// Fix #9: ownerAddress added to every history doc
async function persistHistoryToFirestore(txs: TxHistory[]): Promise<void> {
  if (!state.address || !txs.length) return;
  const CHUNK = 400;
  for (let i = 0; i < txs.length; i += CHUNK) {
    const batch = writeBatch(db);
    for (const tx of txs.slice(i, i + CHUNK)) {
      const docId = tx.hash
        ? `${tx.hash.replace(/[^a-zA-Z0-9]/g, "")}_${tx.type}_${tx.token}`
        : `tx_${tx.ts}_${Math.random().toString(36).slice(2)}`;
      const ref = doc(
        db,
        "users",
        state.address!.toLowerCase(),
        "history",
        docId,
      );
      batch.set(
        ref,
        {
          ...tx,
          ownerAddress: state.address!.toLowerCase(),
          updatedAt: Date.now(),
        },
        { merge: true },
      );
    }
    await batch.commit();
  }
}

function renderHistory() {
  const el = document.getElementById("history-list");
  if (!el) return;
  let txs = [...state.history];
  const q =
    (
      document.getElementById("hist-search") as HTMLInputElement | null
    )?.value.toLowerCase() ?? "";
  const f =
    (document.getElementById("hist-filter") as HTMLInputElement | null)
      ?.value ?? "";
  if (q)
    txs = txs.filter(
      (t) =>
        t.hash?.toLowerCase().includes(q) ||
        t.to?.toLowerCase().includes(q) ||
        t.from?.toLowerCase().includes(q) ||
        t.msg?.toLowerCase().includes(q),
    );
  if (f) txs = txs.filter((t) => t.type === f);
  if (!txs.length) {
    el.innerHTML =
      '<div class="empty-state text-xs">No transactions found</div>';
    return;
  }
  el.innerHTML = txs
    .slice(0, 50)
    .map(
      (t) => `
    <div class="tx-item">
      <div class="tx-icon ${t.type === "sent" ? "sent" : "received"}">${t.type === "sent" ? "↑" : "↓"}</div>
      <div class="tx-meta">
        <div class="tx-addr">${sanitize(t.type === "sent" ? shortAddr(t.to) : shortAddr(t.from))}</div>
        <div class="tx-msg">${t.msg ? sanitize(t.msg) : ""} ${t.tag ? `<span class="tag tag-p" style="font-size:10px">#${sanitize(t.tag)}</span>` : ""}</div>
        <div class="tx-time">${t.hash ? `<a href="${ARC.explorer}/tx/${t.hash}" target="_blank" rel="noopener">${shortHash(t.hash)}</a>` : ""}</div>
      </div>
      <div class="tx-amount ${t.type === "sent" ? "neg" : "pos"}">${t.type === "sent" ? "-" : "+"}${sanitize(t.amount)} ${sanitize(t.token)}</div>
    </div>`,
    )
    .join("");
}
(window as any).renderHistory = renderHistory;

function filterHistory() {
  renderHistory();
}
(window as any).filterHistory = filterHistory;

function renderHomeTx() {
  const el = document.getElementById("home-tx-list");
  if (!el) return;
  const txs = state.history.slice(0, 5);
  if (!txs.length) {
    el.innerHTML =
      '<div class="empty-state text-xs">Connect wallet to load transactions</div>';
    return;
  }
  el.innerHTML = txs
    .map(
      (t) => `
    <div class="tx-item">
      <div class="tx-icon ${t.type === "sent" ? "sent" : "received"}">${t.type === "sent" ? "↑" : "↓"}</div>
      <div class="tx-meta">
        <div class="tx-addr">${sanitize(t.type === "sent" ? shortAddr(t.to) : shortAddr(t.from))}</div>
        <div class="tx-msg">${t.msg ? sanitize(t.msg) : ""}</div>
      </div>
      <div class="tx-amount ${t.type === "sent" ? "neg" : "pos"}">${t.type === "sent" ? "-" : "+"}${sanitize(t.amount)} ${sanitize(t.token)}</div>
    </div>`,
    )
    .join("");
}
(window as any).renderHomeTx = renderHomeTx;

// ── Analytics ──────────────────────────────────────────────
function loadAnalytics() {
  if (!state.history.length && state.address)
    loadHistory().then(buildAnalytics);
  else buildAnalytics();
}
(window as any).loadAnalytics = loadAnalytics;

function buildAnalytics() {
  const txs = state.history;
  const sent = txs
    .filter((t) => t.type === "sent")
    .reduce((s, t) => s + parseFloat(t.amount), 0);
  const recv = txs
    .filter((t) => t.type === "received")
    .reduce((s, t) => s + parseFloat(t.amount), 0);
  setText("ana-sent", sent.toFixed(2) + " USDC");
  setText("ana-recv", recv.toFixed(2) + " USDC");
  setText("ana-count", String(txs.length));
  setText(
    "ana-net",
    (recv - sent >= 0 ? "+" : "") + (recv - sent).toFixed(2) + " USDC",
  );
  setText(
    "ana-usdc-vol",
    txs
      .filter((t) => t.token === "USDC")
      .reduce((s, t) => s + parseFloat(t.amount), 0)
      .toFixed(2) + " USDC",
  );
  setText(
    "ana-eurc-vol",
    txs
      .filter((t) => t.token === "EURC")
      .reduce((s, t) => s + parseFloat(t.amount), 0)
      .toFixed(2) + " EURC",
  );

  const bars = document.getElementById("chart-bars");
  const lbls = document.getElementById("chart-labels");
  if (!bars || !lbls) return;

  const now = new Date();
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(now);
    d.setDate(d.getDate() - (6 - i));
    return d;
  });
  const vals = days.map((d) =>
    txs
      .filter((t) => new Date(t.ts).toDateString() === d.toDateString())
      .reduce((s, t) => s + parseFloat(t.amount), 0),
  );
  const max = Math.max(...vals, 1);
  bars.innerHTML = vals
    .map(
      (v) =>
        `<div class="bar-col"><div class="bar" style="height:${Math.round((v / max) * 80) + 5}px" title="${v.toFixed(2)} USDC"></div></div>`,
    )
    .join("");
  lbls.innerHTML = days
    .map(
      (d) => `<span>${d.toLocaleDateString("en", { weekday: "short" })}</span>`,
    )
    .join("");

  const tags: Record<string, number> = {};
  txs
    .filter((t) => t.type === "sent" && t.tag)
    .forEach((t) => {
      tags[t.tag!] = (tags[t.tag!] || 0) + parseFloat(t.amount);
    });
  const tagEl = document.getElementById("tag-breakdown");
  if (!tagEl) return;
  const tagMax = Math.max(...Object.values(tags), 1);
  const tagColors: Record<string, string> = {
    work: "var(--teal)",
    personal: "var(--p2)",
    rent: "var(--amber)",
    food: "var(--green)",
    other: "var(--red)",
  };
  tagEl.innerHTML = Object.entries(tags).length
    ? Object.entries(tags)
        .sort((a, b) => b[1] - a[1])
        .map(
          ([tag, val]) => `
        <div class="analytic-row">
          <span class="tag tag-p" style="width:72px;justify-content:center">#${sanitize(tag)}</span>
          <div class="analytic-bar-bg"><div class="analytic-bar-fill" style="width:${((val / tagMax) * 100).toFixed(0)}%;background:${tagColors[tag] || "var(--p2)"}"></div></div>
          <span class="fw600 mono text-sm">${val.toFixed(2)}</span>
        </div>`,
        )
        .join("")
    : '<div class="empty-state text-xs">No tagged transactions</div>';
}
(window as any).buildAnalytics = buildAnalytics;

// ── Export ─────────────────────────────────────────────────
function doExport(fmt: string) {
  if (!state.history.length) {
    toast("info", "No transactions to export. Load history first.");
    return;
  }
  if (fmt === "csv") {
    const header = "Date,Type,Token,Amount,From,To,TxHash,Tag,Message";
    const rows = state.history.map((t) =>
      [
        new Date(t.ts).toISOString(),
        t.type,
        t.token,
        t.amount,
        t.from ?? "",
        t.to ?? "",
        t.hash ?? "",
        t.tag ?? "",
        t.msg ?? "",
      ]
        .map((v) => `"${String(v).replace(/"/g, '""')}"`)
        .join(","),
    );
    downloadFile(
      [header, ...rows].join("\n"),
      "crapay_transactions.csv",
      "text/csv",
    );
  } else {
    downloadFile(
      JSON.stringify(state.history, null, 2),
      "crapay_transactions.json",
      "application/json",
    );
  }
  toast("success", "Export downloaded!");
}
(window as any).doExport = doExport;

function downloadFile(content: string, name: string, mime: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([content], { type: mime }));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(a.href);
}
(window as any).downloadFile = downloadFile;

// ── Price Alerts ───────────────────────────────────────────
async function doAddAlert() {
  if (!requireWallet()) return;
  const pair =
    (document.getElementById("alert-pair") as HTMLInputElement)?.value ?? "";
  const cond =
    (document.getElementById("alert-cond") as HTMLInputElement)?.value ?? "";
  const val =
    (document.getElementById("alert-val") as HTMLInputElement)?.value.trim() ??
    "";
  if (!val || isNaN(parseFloat(val))) {
    toast("error", "Enter a valid target value");
    return;
  }
  const alert = {
    id: Date.now(),
    pair,
    cond,
    val,
    active: true,
    createdAt: Date.now(),
  };
  await fbSave("alerts", alert);
  state.alerts.push(alert);
  renderAlerts();
  toast("success", "Alert created!");
  await pushNotif(`Alert set: ${pair} ${cond} ${val}`);
}
(window as any).doAddAlert = doAddAlert;

function renderAlerts() {
  const el = document.getElementById("alerts-list");
  if (!el) return;
  if (!state.alerts.length) {
    el.innerHTML =
      '<div class="empty-state text-xs">No alerts configured</div>';
    return;
  }
  el.innerHTML = state.alerts
    .map(
      (a) => `
    <div class="schedule-item">
      <div class="schedule-dot" style="background:var(--amber)"></div>
      <div style="flex:1;padding-left:8px">
        <div class="fw600 text-sm">${sanitize(a.pair)} ${sanitize(a.cond)} ${sanitize(a.val)}</div>
        <div class="text-xs text-muted mt-4">Created ${fmtDate(a.createdAt)}</div>
      </div>
      <button class="btn btn-danger btn-sm" onclick="deleteAlert(${Number(a.id)})">🗑</button>
    </div>`,
    )
    .join("");
}
(window as any).renderAlerts = renderAlerts;

async function deleteAlert(id: number) {
  state.alerts = state.alerts.filter((x) => x.id !== id);
  await fbDelete("alerts", id);
  renderAlerts();
}
(window as any).deleteAlert = deleteAlert;

// ── Notifications ──────────────────────────────────────────
async function pushNotif(text: string) {
  if (!state.address) return; // no-op if disconnected
  const notif = { id: Date.now(), text, time: Date.now(), read: false };
  try {
    await fbSave("notifications", notif);
  } catch {
    /* non-critical */
  }
  state.notifications.unshift(notif);
  state.notifications = state.notifications.slice(0, 20);
  renderNotifs();
}
(window as any).pushNotif = pushNotif;

function renderNotifs() {
  const el = document.getElementById("notifications-list");
  if (!el) return;
  if (!state.notifications.length) {
    el.innerHTML = '<div class="empty-state text-xs">No notifications</div>';
    return;
  }
  el.innerHTML = state.notifications
    .slice(0, 8)
    .map(
      (n) => `
    <div class="notif-item ${n.read ? "" : "unread"}">
      <div class="notif-dot" style="background:${n.read ? "var(--text3)" : "var(--p)"}"></div>
      <div>
        <div class="fw600 text-sm mb-4">${sanitize(n.text)}</div>
        <div class="text-xs text-muted">${fmtDate(n.time)}</div>
      </div>
    </div>`,
    )
    .join("");
}
(window as any).renderNotifs = renderNotifs;

async function markAllRead() {
  const toUpdate = state.notifications.filter((n) => !n.read);
  state.notifications.forEach((n) => (n.read = true));
  await Promise.allSettled(toUpdate.map((n) => fbSave("notifications", n)));
  renderNotifs();
}
(window as any).markAllRead = markAllRead;

// ── Utilities ──────────────────────────────────────────────
function requireWallet(): boolean {
  if (state.address) return true;
  Swal.fire({
    icon: "warning",
    title: "Connect Wallet",
    text: "Please connect your wallet first.",
    background: "#0f1118",
    color: "#eef0ff",
    confirmButtonColor: "#6c63ff",
  });
  return false;
}
(window as any).requireWallet = requireWallet;

function getActiveToken(tabsId: string): string {
  const el = document.querySelector(
    `#${tabsId} .token-tab.active`,
  ) as HTMLElement | null;
  return el?.dataset.token ?? "USDC";
}
(window as any).getActiveToken = getActiveToken;

function selectToken(el: HTMLElement, tabsId: string) {
  document
    .querySelectorAll(`#${tabsId} .token-tab`)
    .forEach((t) => t.classList.remove("active"));
  el.classList.add("active");
  if (tabsId === "send-token-tabs") updateSendBalances();
  if (tabsId === "link-token-tabs") updateLinkPreview();
  if (tabsId === "multi-token-tabs") updateMultiCount();
}
(window as any).selectToken = selectToken;

function updateSendBalances() {
  setText("send-usdc-bal", state.usdcBal + " USDC");
  setText("send-eurc-bal", state.eurcBal + " EURC");
}
(window as any).updateSendBalances = updateSendBalances;

function setText(id: string, val: string) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}
(window as any).setText = setText;

function clearFields(ids: string[]) {
  ids.forEach((id) => {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (el) el.value = "";
  });
}
(window as any).clearFields = clearFields;

function shortAddr(a?: string | null): string {
  if (!a) return "—";
  return a.length <= 12 ? a : a.slice(0, 6) + "…" + a.slice(-4);
}
(window as any).shortAddr = shortAddr;

function shortHash(h?: string | null): string {
  if (!h) return "—";
  return h.slice(0, 10) + "…" + h.slice(-6);
}
(window as any).shortHash = shortHash;

function cap(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : "";
}
(window as any).cap = cap;

function fmtDate(ts?: number | null): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleDateString("en", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
(window as any).fmtDate = fmtDate;

function currentPage(): string {
  return (
    document.querySelector(".page.active")?.id.replace("page-", "") ?? "home"
  );
}
(window as any).currentPage = currentPage;

function copyText(elId: string) {
  const el = document.getElementById(elId);
  if (!el) return;
  navigator.clipboard
    .writeText(el.textContent ?? "")
    .then(() => toast("success", "Copied!"))
    .catch(() => toast("error", "Copy failed"));
}
(window as any).copyText = copyText;

function copyVal(val: string) {
  navigator.clipboard
    .writeText(val)
    .then(() => toast("success", "Copied!"))
    .catch(() => toast("error", "Copy failed"));
}
(window as any).copyVal = copyVal;

function toast(icon: string, text: string) {
  (
    Swal.mixin({
      toast: true,
      position: "top-end",
      showConfirmButton: false,
      timer: 2800,
      timerProgressBar: true,
      background: "#161923",
      color: "#eef0ff",
    }) as any
  ).fire({ icon, title: text });
}
(window as any).toast = toast;

function setLoading(
  btn: HTMLButtonElement | null,
  loading: boolean,
  text?: string,
): void {
  if (!btn) return;
  if (loading) {
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span>${text ?? "Sending…"}`;
  } else {
    btn.disabled = false;
    if (text) btn.innerHTML = text;
  }
}
(window as any).setLoading = setLoading;

function showModal(title: string, body: string) {
  const t = document.getElementById("modal-title");
  const b = document.getElementById("modal-body");
  const m = document.getElementById("modal");
  if (!t || !b || !m) return;
  t.innerHTML = title;
  b.innerHTML = body;
  m.classList.add("open");
}
(window as any).showModal = showModal;

function showSuccessModal(title: string, body: string) {
  showModal(`<span style="color:var(--green)">${title}</span>`, body);
}
(window as any).showSuccessModal = showSuccessModal;

// Fix #1: closeModal takes NO argument
function closeModal(): void {
  document.getElementById("modal")?.classList.remove("open");
}
(window as any).closeModal = closeModal;

// ── Deep Link ──────────────────────────────────────────────
function checkDeepLink() {
  const p = new URLSearchParams(window.location.search);
  if (!p.get("to")) return;
  nav("send");
  const toEl = document.getElementById("send-to") as HTMLInputElement | null;
  const amountEl = document.getElementById(
    "send-amount",
  ) as HTMLInputElement | null;
  const msgEl = document.getElementById("send-msg") as HTMLInputElement | null;
  if (toEl) toEl.value = p.get("to") ?? "";
  if (amountEl) amountEl.value = p.get("amount") ?? "";
  if (msgEl) msgEl.value = decodeURIComponent(p.get("msg") ?? "");
  const token = p.get("token") ?? "USDC";
  document.querySelectorAll("#send-token-tabs .token-tab").forEach((t) => {
    const tab = t as HTMLElement;
    tab.classList.toggle("active", tab.dataset.token === token);
  });
}
(window as any).checkDeepLink = checkDeepLink;

// ── Init — Fix #13: wait for DOMContentLoaded ──────────────
function initApp() {
  renderContacts();
  renderSchedules();
  renderHomeSchedule();
  renderHomeTx();
  renderNotifs();
  renderAlerts();
  renderLinks();
  renderSplitHistory();
  checkDeepLink();
  const schedDate = document.getElementById(
    "sched-date",
  ) as HTMLInputElement | null;
  if (schedDate) schedDate.value = new Date().toISOString().split("T")[0];
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initApp);
} else {
  initApp(); // already loaded (e.g. module script after DOM)
}

// ── Mobile Drawer ──────────────────────────────────────────
function toggleDrawer() {
  const drawer = document.getElementById("mobile-drawer");
  const overlay = document.getElementById("drawer-overlay");
  const btn = document.getElementById("hamburger-btn");
  const isOpen = drawer?.classList.contains("open");
  if (isOpen) {
    closeDrawer();
  } else {
    drawer?.classList.add("open");
    overlay?.classList.add("open");
    btn?.classList.add("open");
    document.body.style.overflow = "hidden"; // chặn scroll nền
  }
}
(window as any).toggleDrawer = toggleDrawer;

function closeDrawer() {
  document.getElementById("mobile-drawer")?.classList.remove("open");
  document.getElementById("drawer-overlay")?.classList.remove("open");
  document.getElementById("hamburger-btn")?.classList.remove("open");
  document.body.style.overflow = "";
}
(window as any).closeDrawer = closeDrawer;

// Nav từ drawer: navigate + đóng drawer + sync active
function navDrawer(id: string) {
  nav(id);
  closeDrawer();
  // Sync active state trong drawer
  document.querySelectorAll(".mobile-drawer .nav-item").forEach((n) => {
    n.classList.toggle(
      "active",
      n.getAttribute("onclick")?.includes(`'${id}'`) ?? false,
    );
  });
}
(window as any).navDrawer = navDrawer;

// ── Agentic approval: lưu trên Firebase thay vì localStorage ─────────────

async function fbIsAgenticApproved(): Promise<boolean> {
  if (!state.address) return false;
  try {
    const snap = await getDocs(
      query(userCol("agentic"), where("ownerAddress", "==", state.address.toLowerCase()))
    );
    if (snap.empty) return false;
    return snap.docs[0]?.data()?.approved === true;
  } catch { return false; }
}

async function fbSetAgenticApproved(): Promise<void> {
  if (!state.address) return;
  await setDoc(
    userDocRef("agentic", "approval"),
    { approved: true, approvedAt: Date.now(), ownerAddress: state.address.toLowerCase(), updatedAt: Date.now() },
    { merge: true }
  );
  // Sync vào localStorage để agenticPayment.ts (dùng localStorage) nhận biết ngay
  try { localStorage.setItem("crapay_agentic_approved_v1_" + state.address.toLowerCase(), "1"); } catch {}
}

async function fbClearAgenticApproved(): Promise<void> {
  if (!state.address) return;
  await setDoc(
    userDocRef("agentic", "approval"),
    { approved: false, approvedAt: null, ownerAddress: state.address.toLowerCase(), updatedAt: Date.now() },
    { merge: true }
  );
  try { localStorage.removeItem("crapay_agentic_approved_v1_" + state.address.toLowerCase()); } catch {}
}

/**
 * Approve relayer address để server có thể transferFrom USDC khi đến hạn.
 * Chỉ approve 1 lần — nếu đã approve MAX_UINT thì skip.
 */
async function ensureRelayerApproval(
  signer: ethers.JsonRpcSigner,
  relayerAddress: string
): Promise<void> {
  const ERC20_APPROVE_ABI = [
    "function allowance(address owner, address spender) view returns (uint256)",
    "function approve(address spender, uint256 amount) returns (bool)",
  ];
  // Lấy USDC token address từ agenticPayment constants
  const USDC = "0x3600000000000000000000000000000000000000";
  const MAX  = ethers.MaxUint256;

  const userAddress = await signer.getAddress();
  const provider    = signer.provider!;
  const usdc        = new ethers.Contract(USDC, ERC20_APPROVE_ABI, provider);

  const allowance: bigint = await usdc.allowance(userAddress, relayerAddress);
  // Nếu còn > 1000 USDC allowance thì coi như đã approve rồi, skip
  if (allowance >= ethers.parseUnits("1000", 6)) return;

  const usdcWithSigner = usdc.connect(signer) as ethers.Contract;
  const tx = await usdcWithSigner.approve(relayerAddress, MAX);
  await tx.wait();
}

/**
 * Wrapper cho ensureAgenticApproval — check Firebase trước, sync vào localStorage,
 * rồi sau khi approve xong lưu lại Firebase.
 */
async function ensureAgenticApprovalWithFb(signer: ethers.JsonRpcSigner): Promise<void> {
  const address = await signer.getAddress();
  const fbApproved = await fbIsAgenticApproved();
  if (fbApproved) {
    // Đã approved trên Firebase → sync localStorage để agenticPayment.ts skip approval
    try { localStorage.setItem("crapay_agentic_approved_v1_" + address.toLowerCase(), "1"); } catch {}
  }
  await ensureAgenticApproval(signer);
  if (!fbApproved) {
    await fbSetAgenticApproved();
  }
}

// Sync approval flag từ Firebase vào localStorage khi app load
async function syncAgenticApprovalFromFb(): Promise<void> {
  if (!state.address) return;
  try {
    const approved = await fbIsAgenticApproved();
    if (approved) {
      localStorage.setItem("crapay_agentic_approved_v1_" + state.address.toLowerCase(), "1");
    } else {
      localStorage.removeItem("crapay_agentic_approved_v1_" + state.address.toLowerCase());
    }
  } catch {}
}

// ── Agentic Payment Page ────────────────────────────────────────────────
 
function initAgenticPage(): void {
  setText("agentic-usdc-bal", state.usdcBal + " USDC");
  updateAgenticBanner();
  renderAgenticHistory();
}
(window as any).initAgenticPage = initAgenticPage;
 
function updateAgenticBanner(): void {
  const banner = document.getElementById("agentic-approval-banner");
  const icon   = document.getElementById("agentic-approval-icon");
  const title  = document.getElementById("agentic-approval-title");
  const sub    = document.getElementById("agentic-approval-sub");
  const resetBtn = document.getElementById("agentic-reset-btn");
  if (!banner) return;
 
  banner.style.display = "flex";
 
  const _agApproved = state.address ? localStorage.getItem("crapay_agentic_approved_v1_" + state.address.toLowerCase()) === "1" : false;
  if (_agApproved) {
    if (icon)  icon.textContent  = "✅";
    if (title) title.textContent = "Approved — payments are fully automatic";
    if (sub)   sub.textContent   = "You signed once. All future payments run without wallet prompts.";
    if (resetBtn) resetBtn.style.display = "inline-flex";
    banner.style.borderLeft = "3px solid rgba(76,175,80,0.6)";
    banner.style.background = "rgba(76,175,80,0.05)";
  } else {
    if (icon)  icon.textContent  = "🔓";
    if (title) title.textContent = "One-time approval required";
    if (sub)   sub.textContent   = "You'll sign once on your first payment. Never again after that.";
    if (resetBtn) resetBtn.style.display = "none";
    banner.style.borderLeft = "3px solid rgba(108,99,255,0.5)";
    banner.style.background = "rgba(108,99,255,0.05)";
  }
}
(window as any).updateAgenticBanner = updateAgenticBanner;
 
async function doAgenticPayment(): Promise<void> {
  if (!requireWallet()) return;
 
  const toEl     = document.getElementById("agentic-to")     as HTMLInputElement;
  const amountEl = document.getElementById("agentic-amount") as HTMLInputElement;
  const descEl   = document.getElementById("agentic-desc")   as HTMLInputElement;
  const expiryEl = document.getElementById("agentic-expiry") as HTMLSelectElement;
  const btn      = document.getElementById("agentic-pay-btn") as HTMLButtonElement;
 
  const recipient    = toEl?.value.trim();
  const amount       = amountEl?.value.trim();
  const description  = descEl?.value.trim() || "Agentic Payment via CRAPAY";
  const expirySeconds = parseInt(expiryEl?.value || "86400");
 
  if (!recipient || !ethers.isAddress(recipient)) {
    toast("error", "Invalid recipient address"); return;
  }
  if (!amount || parseFloat(amount) <= 0) {
    toast("error", "Enter a valid amount"); return;
  }
  if (parseFloat(amount) > parseFloat(state.usdcBal)) {
    toast("error", "Insufficient USDC balance"); return;
  }
  if (!state.signer) {
    toast("error", "Wallet not connected"); return;
  }
 
  setLoading(btn, true, "Processing…");
 
  try {
    await ensureArcNetwork();
 
    const result = await agenticPaymentWithUI(state.signer, {
      recipient,
      amount,
      description,
      expirySeconds,
      onComplete: async (jobId, txHash) => {
        // Thêm vào local state history (hiển thị ngay, không cần Firebase)
        const entry: TxHistory = {
          hash: txHash,
          from: state.address!,
          to: recipient,
          amount,
          token: "USDC",
          type: "agentic",
          msg: `Job #${jobId} — ${description}`,
          ts: Date.now(),
          ownerAddress: state.address!.toLowerCase(),
        };
        state.history.unshift(entry);
 
        // Refresh
        await refreshBalances();
        renderHomeTx();
        renderAgenticHistory();
        updateAgenticBanner();
        clearFields(["agentic-to", "agentic-amount", "agentic-desc"]);
      },
    });
 
    if (!result) {
      // User cancelled — đã hiện dialog trong agenticPaymentWithUI
    }
  } catch (err: any) {
    toast("error", err?.message ?? "Payment failed");
  } finally {
    setLoading(btn, false, "⚡ Send Agentic Payment");
  }
}
(window as any).doAgenticPayment = doAgenticPayment;
 
async function agenticResetApproval(): Promise<void> {
  if (!state.address) return;
  await fbClearAgenticApproved();
  updateAgenticBanner();
  toast("info", "Approval reset — next payment will ask for signature");
}
(window as any).agenticResetApproval = agenticResetApproval;
 
/** Sync: scan JobCreated events từ onchain, cập nhật history */
async function agenticSyncHistory(): Promise<void> {
  if (!state.address) { toast("error", "Connect wallet first"); return; }
  const btn = document.querySelector("[onclick='agenticSyncHistory()']") as HTMLButtonElement;
  if (btn) { btn.disabled = true; btn.textContent = "Syncing…"; }
 
  try {
    const jobs = await fetchJobsFromEvents(state.address);
    renderAgenticHistoryFromJobs(jobs);
    toast("success", `Synced ${jobs.length} job(s) from chain`);
  } catch (e: any) {
    toast("error", "Sync failed: " + (e?.message ?? "Unknown error"));
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "🔄 Sync from chain"; }
  }
}
(window as any).agenticSyncHistory = agenticSyncHistory;
 
/** Render từ state.history (local, nhanh) */
function renderAgenticHistory(): void {
  const agenticTxs = state.history
    .filter((h) => h.type === "agentic")
    .slice(0, 15);
 
  if (!agenticTxs.length) {
    // Thử đọc từ onchain nếu có address
    if (state.address) {
      fetchJobsByAddress(state.address)
        .then(renderAgenticHistoryFromJobs)
        .catch(() => {});
    }
    return;
  }
 
  const el = document.getElementById("agentic-history");
  if (!el) return;
 
  el.innerHTML = agenticTxs.map((tx) => `
    <div class="tx-item" style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--border)">
      <div style="width:36px;height:36px;border-radius:50%;background:rgba(108,99,255,0.15);
                  display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0">⚡</div>
      <div style="flex:1;min-width:0">
        <div class="fw600 text-sm">${sanitize(tx.msg ?? "Agentic Payment")}</div>
        <div class="text-xs text-muted">→ ${shortAddr(tx.to)} · ${fmtDate(tx.ts)}</div>
      </div>
      <div style="text-align:right;font-size:13px;font-weight:600;color:var(--red);flex-shrink:0">
        -${sanitize(tx.amount)} USDC
        ${tx.hash
          ? `<a href="https://testnet.arcscan.app/tx/${tx.hash}" target="_blank"
               style="display:block;font-size:11px;color:#6c63ff;text-decoration:none;font-weight:400">
               View ↗</a>`
          : ""}
      </div>
    </div>`).join("");
}
(window as any).renderAgenticHistory = renderAgenticHistory;
 
/** Render từ onchain jobs (sau khi sync) */
function renderAgenticHistoryFromJobs(jobs: OnchainJob[]): void {
  const el = document.getElementById("agentic-history");
  if (!el) return;
 
  if (!jobs.length) {
    el.innerHTML = '<div class="empty-state text-xs">No agentic payments found onchain</div>';
    return;
  }
 
  const statusColor = (s: string) =>
    s === "Completed" ? "#4caf50" : s === "Rejected" || s === "Expired" ? "#f44336" : "#6c63ff";
 
  el.innerHTML = jobs.map((job) => `
    <div class="tx-item" style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--border)">
      <div style="width:36px;height:36px;border-radius:50%;background:rgba(108,99,255,0.15);
                  display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0">⚡</div>
      <div style="flex:1;min-width:0">
        <div class="fw600 text-sm">${sanitize(job.description)}</div>
        <div class="text-xs text-muted">
          → ${shortAddr(job.provider)} · Job #${sanitize(job.jobId)}
        </div>
        <div class="text-xs" style="color:${statusColor(job.status)};margin-top:2px">
          ${sanitize(job.status)}
        </div>
      </div>
      <div style="text-align:right;font-size:13px;font-weight:600;color:var(--red);flex-shrink:0">
        ${sanitize(job.budget)} USDC
        <a href="https://testnet.arcscan.app/address/0x0747EEf0706327138c69792bF28Cd525089e4583?tab=contract" target="_blank"
           style="display:block;font-size:11px;color:#6c63ff;text-decoration:none;font-weight:400">
          Arcscan ↗</a>
      </div>
    </div>`).join("");
}
(window as any).renderAgenticHistoryFromJobs = renderAgenticHistoryFromJobs;
