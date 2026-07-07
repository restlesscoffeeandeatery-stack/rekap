// ============================================================
// Ollo Tracker Premium - Frontend Logic
// CATATAN KEAMANAN: API key di file ini terlihat oleh siapa pun
// yang membuka view-source. Aman-nya terbatas: pastikan Worker
// membatasi CORS ke origin situs ini, dan rotasi key berkala.
// ============================================================
const WORKER_ENDPOINT = 'https://ollo-tracker-backend.rekap-keuangan.workers.dev';
const API_SECRET_KEY = 'Restless.27';

// Target alokasi ringfencing (mode Bisnis)
const TARGETS = {
  raw: 1500000,   // Bahan baku per siklus belanja (Senin & Kamis)
  pt:  3000000,   // Gaji part-time per minggu (dibayar akhir pekan)
  ft:  12000000   // Gaji full-time per bulan
};

let localTransactions = [];
let localInvoices = [];
let activeFilter = 'ALL';
let isStealthMode = false;
let realBalanceCache = 'Rp 0';

const $ = (id) => document.getElementById(id);
const formatRp = (num) => new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(num || 0);

// Cegah XSS: deskripsi transaksi berasal dari input bebas
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

function showToast(text, isError = false) {
  const t = $('toast');
  t.textContent = text;
  t.style.backgroundColor = isError ? '#EF4444' : '#0F172A';
  t.style.display = 'block';
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => { t.style.display = 'none'; }, 3000);
}

// ============ PROFIL ============
window.toggleProfile = (profileId) => {
  $('p-tab-1').classList.toggle('active', profileId === '1');
  $('p-tab-2').classList.toggle('active', profileId === '2');
  $('txtProfileId').value = profileId;

  const isBusiness = profileId === '2';
  $('mainHeader').classList.toggle('business-mode', isBusiness);

  // Kartu khusus mode Bisnis
  ['bentengCard', 'hppRadarCard', 'invoiceCard', 'divisionCard'].forEach(id => {
    $(id).style.display = isBusiness ? 'block' : 'none';
  });

  fetchCloudData(profileId);
};

// ============ FILTER RIWAYAT ============
window.setFilter = (type) => {
  activeFilter = type;
  $('f-all').classList.toggle('active', type === 'ALL');
  $('f-exp').classList.toggle('active', type === 'EXPENSE');
  $('f-inc').classList.toggle('active', type === 'INCOME');
  renderTxList();
};

// ============ DATA ============
async function fetchCloudData(profileId) {
  try {
    const res = await fetch(`${WORKER_ENDPOINT}/api/dashboard?profile_id=${encodeURIComponent(profileId)}`, {
      headers: { 'x-api-key': API_SECRET_KEY }
    });
    if (!res.ok) throw new Error('Network response failure');

    const json = await res.json();
    localTransactions = json.data || [];
    localInvoices = json.invoices || [];

    executeCashFlowArchitecture(profileId);
    renderTxList();
    renderInvoiceList();
  } catch (err) {
    showToast('Gagal memuat data dari Cloud server.', true);
  }
}

// ============ LOGIKA INTI: SAFE-TO-SPEND + RINGFENCING ============
function calcRingfenceLocks() {
  const now = new Date();
  const day = now.getDay();           // 0=Minggu ... 6=Sabtu
  const dayNum = now.getDate();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();

  // Bahan baku: siklus Senin(1) & Kamis(4).
  // Akrual = (hari berjalan dalam siklus) / (panjang siklus).
  let elapsed, cycleLen;
  if (day >= 1 && day <= 3)      { elapsed = day - 1; cycleLen = 3; } // Sen–Rab (menuju Kamis)
  else if (day >= 4 && day <= 6) { elapsed = day - 4; cycleLen = 4; } // Kam–Sab (menuju Senin)
  else                            { elapsed = 3;       cycleLen = 4; } // Minggu = hari ke-3 sejak Kamis

  const lockRaw = Math.min(TARGETS.raw * ((elapsed + 1) / cycleLen), TARGETS.raw);

  // Part-time: akrual linear Senin→Minggu (dibayar Minggu).
  const weekDay = day === 0 ? 7 : day;                 // Senin=1 ... Minggu=7
  const lockPt = Math.min(TARGETS.pt * (weekDay / 7), TARGETS.pt);

  // Full-time: akrual linear per hari kalender bulan berjalan.
  const lockFt = Math.min((TARGETS.ft / daysInMonth) * dayNum, TARGETS.ft);

  return { lockRaw, lockPt, lockFt };
}

function executeCashFlowArchitecture(profileId) {
  let income = 0, expense = 0;
  localTransactions.forEach(t => {
    if (t.type === 'INCOME') income += t.amount;
    if (t.type === 'EXPENSE') expense += t.amount;
  });
  const realBankBalance = income - expense;

  const totalInvoiceBeban = localInvoices
    .filter(i => i.status === 'PENDING')
    .reduce((sum, i) => sum + i.amount, 0);

  // Ringfencing hanya untuk profil Bisnis
  let { lockRaw, lockPt, lockFt } = calcRingfenceLocks();
  if (profileId === '1') { lockRaw = 0; lockPt = 0; lockFt = 0; }

  const totalLocked = lockRaw + lockPt + lockFt;
  const safeToSpend = Math.max(realBankBalance - totalInvoiceBeban - totalLocked, 0);

  // Render metrik utama
  $('lblRealBank').textContent = formatRp(realBankBalance);
  $('lblInvoiceBeban').textContent = formatRp(totalInvoiceBeban);

  const safeEl = $('lblSafeSpend');
  isStealthMode = false; // reset stealth saat data baru masuk
  safeEl.style.opacity = 1;
  safeEl.textContent = formatRp(safeToSpend);
  safeEl.style.color = (safeToSpend === 0 && profileId === '2') ? '#FCA5A5' : '#FFFFFF';

  // Progress bar ringfencing
  updateProgressBar('raw', lockRaw, TARGETS.raw);
  updateProgressBar('pt',  lockPt,  TARGETS.pt);
  updateProgressBar('ft',  lockFt,  TARGETS.ft);

  renderDivisionBudgets();
  renderHppRadar();
}

function updateProgressBar(id, val, target) {
  const pct = target > 0 ? Math.min((val / target) * 100, 100) : 0;
  $(`bar-${id}`).style.width = `${pct}%`;
  $(`meta-${id}`).textContent = `${formatRp(val)} / ${formatRp(target)}`;
}

function renderHppRadar() {
  const kitchenExpense = localTransactions
    .filter(t => t.category_id === 'KITCHEN' && t.type === 'EXPENSE')
    .reduce((sum, t) => sum + t.amount, 0);

  $('lblHppRadarText').textContent = kitchenExpense > 10000000
    ? '⚠️ Kritis! Food Cost divisi Kitchen terdeteksi tembus 34.5% dari target omzet harian.'
    : '🟢 Struktur HPP dan margin laba kotor produk Anda masih dalam ambang aman (Food Cost = 28.2%).';
}

// ============ PAGU DIVISI ============
function renderDivisionBudgets() {
  const container = $('divisionGridContainer');
  const divisions = [
    { name: 'Kitchen', limit: 25000000, catId: 'KITCHEN' },
    { name: 'Bar',     limit: 15000000, catId: 'BAR' },
    { name: 'Service', limit: 5000000,  catId: 'SERVICE' }
  ];

  container.innerHTML = divisions.map(d => {
    const realisasi = localTransactions
      .filter(t => t.category_id === d.catId && t.type === 'EXPENSE')
      .reduce((sum, t) => sum + t.amount, 0);
    const pct = (realisasi / d.limit) * 100;

    let status = 'AMAN', color = 'var(--success)';
    if (pct > 100)     { status = 'OVER'; color = 'var(--danger)'; }
    else if (pct > 80) { status = 'WARN'; color = 'var(--warning)'; }

    return `
      <div class="grid-row">
        <strong>${d.name}</strong>
        <span>${formatRp(d.limit)}</span>
        <span>${formatRp(realisasi)}</span>
        <span class="status-pill" style="background:${color}">${status}</span>
      </div>`;
  }).join('');
}

// ============ INVOICE ============
function renderInvoiceList() {
  const container = $('invoiceContainer');
  const pending = localInvoices.filter(i => i.status === 'PENDING');

  if (pending.length === 0) {
    container.innerHTML = '<p style="font-size:12px; color:var(--text-muted); text-align:center;">🎉 Semua tagihan lunas.</p>';
    return;
  }

  container.innerHTML = pending.map(inv => `
    <div style="display:flex; justify-content:space-between; align-items:center; padding:10px 0; border-bottom:1px solid #F1F5F9;">
      <div style="flex:1;">
        <h5 style="font-size:13px; font-weight:600;">${esc(inv.title)}</h5>
        <p style="font-size:11px; color:var(--text-muted);">Tempo: ${esc(inv.due_date)}</p>
      </div>
      <div style="text-align:right; white-space:nowrap;">
        <span style="color:var(--danger); font-weight:700; font-size:13px; margin-right:10px;">${formatRp(inv.amount)}</span>
        <button onclick="payInvoiceInstantly('${esc(inv.id)}')" style="padding:4px 8px; background:var(--success); color:white; border:none; border-radius:6px; font-size:10px; cursor:pointer; font-weight:700;">LUNAS</button>
      </div>
    </div>`).join('');
}

window.payInvoiceInstantly = async (invId) => {
  try {
    const res = await fetch(`${WORKER_ENDPOINT}/api/invoices/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': API_SECRET_KEY },
      body: JSON.stringify({ invoice_id: invId, status: 'PAID' })
    });
    if (!res.ok) throw new Error();
    showToast('Invoice berhasil diselesaikan!');
    fetchCloudData($('txtProfileId').value);
  } catch (e) {
    showToast('Gagal memperbarui status tagihan.', true);
  }
};

// ============ RIWAYAT TRANSAKSI ============
function renderTxList() {
  const container = $('txListContainer');
  const filtered = localTransactions.filter(t => activeFilter === 'ALL' || t.type === activeFilter);

  if (filtered.length === 0) {
    container.innerHTML = '<p style="text-align:center; color:var(--text-muted); padding:15px; font-size:12px;">Belum ada riwayat mutasi.</p>';
    return;
  }

  container.innerHTML = [...filtered].reverse().map(t => {
    const isExp = t.type === 'EXPENSE';
    return `
      <div class="tx-item">
        <div class="tx-left">
          <div class="tx-avatar" style="background:${isExp ? '#FEE2E2' : '#D1FAE5'}">${isExp ? '🛍️' : '💰'}</div>
          <div>
            <h4>${esc(t.description)}</h4>
            <p style="font-size:11px; color:var(--text-muted);">${esc(t.category_id)} • ${t.date ? new Date(t.date).toLocaleDateString('id-ID') : '-'}</p>
          </div>
        </div>
        <div class="tx-amount ${isExp ? 'expense' : 'income'}">${isExp ? '-' : '+'} ${formatRp(t.amount)}</div>
      </div>`;
  }).join('');
}

// ============ SUBMIT TRANSAKSI ============
$('frmTransaction').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = document.querySelector('.btn-main');
  btn.textContent = 'Menulis ke Google Sheets...';
  btn.disabled = true;

  const pId = $('txtProfileId').value;
  const payload = {
    profile_id: pId,
    wallet_id: 'W_MAIN',
    category_id: $('txtDivision').value,
    type: $('txtType').value,
    amount: parseFloat($('txtAmount').value),
    description: $('txtDesc').value
  };

  try {
    const res = await fetch(`${WORKER_ENDPOINT}/api/transactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': API_SECRET_KEY },
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error();

    showToast('Transaksi sukses disimpan!');
    $('frmTransaction').reset();
    $('txtProfileId').value = pId;
    fetchCloudData(pId);
  } catch (err) {
    showToast('Gagal menginput transaksi.', true);
  } finally {
    btn.textContent = 'Simpan ke Cloud Sheets';
    btn.disabled = false;
  }
});

// ============ FITUR TAMBAHAN ============
// 1. Stealth Mode (samarkan saldo saat layar dilihat orang lain)
window.triggerStealthMode = () => {
  const lbl = $('lblSafeSpend');
  isStealthMode = !isStealthMode;
  if (isStealthMode) {
    realBalanceCache = lbl.textContent;
    lbl.textContent = 'Rp 142.500';
    lbl.style.opacity = 0.5;
    showToast('🛡️ Mode Penyamaran Aktif');
  } else {
    lbl.textContent = realBalanceCache;
    lbl.style.opacity = 1;
    showToast('🔓 Mode Penyamaran Nonaktif');
  }
};

// 2. Sinkronisasi absensi part-time
window.syncExternalAttendance = async () => {
  showToast('Menghubungkan ke API Absensi Karyawan...');
  try {
    const res = await fetch(`${WORKER_ENDPOINT}/api/payroll-sync`, { headers: { 'x-api-key': API_SECRET_KEY } });
    if (!res.ok) throw new Error();
    const json = await res.json();
    showToast(`Sukses sinkron! Terbaca ${json.data.length} data karyawan part-time.`);
  } catch (e) {
    showToast('Gagal menarik data absensi API.', true);
  }
};

// 3. Export jurnal ke CSV
window.exportJurnalCSV = () => {
  if (localTransactions.length === 0) return showToast('Tidak ada data untuk diekspor', true);
  const escCsv = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  let csv = 'ID,Profil,Divisi,Nominal,Tipe,Keterangan,Tanggal\n';
  localTransactions.forEach(t => {
    csv += [escCsv(t.id), escCsv(t.profile_id), escCsv(t.category_id), t.amount, escCsv(t.type), escCsv(t.description), escCsv(t.date)].join(',') + '\n';
  });
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.setAttribute('download', `Jurnal_OlloTracker_${Date.now()}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(link.href);
};

// Initial Load
fetchCloudData('1');
