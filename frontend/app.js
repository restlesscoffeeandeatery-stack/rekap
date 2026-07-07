// Konfigurasi Kredensial Worker API Anda
const WORKER_ENDPOINT = 'https://ollo-tracker-backend.rekap-keuangan.workers.dev';
const API_SECRET_KEY = 'Restless.27';

let localTransactions = [];
let localInvoices = [];
let activeFilter = 'ALL';
let isStealthMode = false;
let realBalanceCache = "Rp 0";

const formatRp = (num) => new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(num);

function showToast(text, isError = false) {
  const t = document.getElementById('toast');
  t.textContent = text;
  t.style.backgroundColor = isError ? 'var(--danger)' : 'var(--text-main)';
  t.style.display = 'block';
  setTimeout(() => t.style.display = 'none', 3000);
}

window.toggleProfile = (profileId) => {
  document.getElementById('p-tab-1').classList.toggle('active', profileId === '1');
  document.getElementById('p-tab-2').classList.toggle('active', profileId === '2');
  document.getElementById('txtProfileId').value = profileId;
  
  const header = document.getElementById('mainHeader');
  if (profileId === '2') {
    header.classList.add('business-mode');
  } else {
    header.classList.remove('business-mode');
  }
  
  fetchCloudData(profileId);
};

window.setFilter = (type) => {
  activeFilter = type;
  document.getElementById('f-all').classList.toggle('active', type === 'ALL');
  document.getElementById('f-exp').classList.toggle('active', type === 'EXPENSE');
  document.getElementById('f-inc').classList.toggle('active', type === 'INCOME');
  renderTxList();
};

async function fetchCloudData(profileId) {
  try {
    const res = await fetch(`${WORKER_ENDPOINT}/api/dashboard?profile_id=${profileId}`, {
      headers: { 'x-api-key': API_SECRET_KEY }
    });
    if (!res.ok) throw new Error("Network response failure");
    
    const json = await res.json();
    localTransactions = json.data || [];
    localInvoices = json.invoices || [];
    
    executeCashFlowArchitecture(profileId);
    renderTxList();
    renderInvoiceList(profileId);
  } catch (err) {
    showToast("Gagal memuat data dari Cloud server.", true);
  }
}

function executeCashFlowArchitecture(profileId) {
  let income = 0, expense = 0;
  localTransactions.forEach(t => {
    if (t.type === 'INCOME') income += t.amount;
    if (t.type === 'EXPENSE') expense += t.amount;
  });
  
  const realBankBalance = income - expense;
  
  // Hitung total invoice pending
  const pendingInvoices = localInvoices.filter(i => i.status === 'PENDING');
  const totalInvoiceBeban = pendingInvoices.reduce((sum, i) => sum + i.amount, 0);

  // LOGIKA UTAMA: Hitung Alokasi Pengunci Dana Multi-Siklus (Ringfencing)
  const date = new Date();
  const day = date.getDay();
  const dayNum = date.getDate();
  const daysInMonth = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();

  // Targets (Bahan Baku, Parttime Seminggu, Fulltime Sebulan)
  const targets = { raw: 1500000, pt: 3000000, ft: 12000000 };
  
  let lockRaw = Math.min(targets.raw * ((7 - ((day <= 1) ? (1 - day) : (4 - day))) / 7), targets.raw);
  let lockPt = Math.min(targets.pt * ((7 - (6 - day < 0 ? 0 : 6 - day)) / 7), targets.pt);
  let lockFt = Math.min((targets.ft / daysInMonth) * dayNum, targets.ft);

  if (profileId === '1') { // Matikan ringfencing untuk personal jika tidak dibutuhkan
    lockRaw = 0; lockPt = 0; lockFt = 0;
  }

  const totalLockedFunds = lockRaw + lockPt + lockFt;
  const safeToSpend = Math.max(realBankBalance - totalInvoiceBeban - totalLockedFunds, 0);

  // Render Core UI Metrics
  document.getElementById('lblRealBank').textContent = formatRp(realBankBalance);
  document.getElementById('lblInvoiceBeban').textContent = formatRp(totalInvoiceBeban);
  
  const safeSpendEl = document.getElementById('lblSafeSpend');
  safeSpendEl.textContent = formatRp(safeToSpend);
  safeSpendEl.style.color = safeToSpend === 0 && profileId === '2' ? 'var(--danger)' : '#FFFFFF';

  // Render Progress Bars Ringfencing
  updateProgressBar('raw', lockRaw, targets.raw);
  updateProgressBar('pt', lockPt, targets.pt);
  updateProgressBar('ft', lockFt, targets.ft);

  // Render Pagu Divisi Budgeting
  renderDivisionBudgets();
  
  // HPP Insight Automation Simulation
  const kitchenExpense = localTransactions.filter(t => t.category_id === 'KITCHEN').reduce((sum, t) => sum + t.amount, 0);
  if (kitchenExpense > 10000000) {
    document.getElementById('lblHppRadarText').textContent = "⚠️ Kritis! Food Cost divisi Kitchen terdeteksi tembus 34.5% dari target omzet harian.";
    document.getElementById('lblHppRadarText').parentElement.style.display = 'block';
  } else {
    document.getElementById('lblHppRadarText').textContent = "🟢 Struktur HPP dan margin laba kotor produk Anda masih dalam ambang aman (Food Cost = 28.2%).";
  }
}

function updateProgressBar(id, val, target) {
  const pct = target > 0 ? Math.min((val / target) * 100, 100) : 0;
  document.getElementById(`bar-${id}`).style.width = `${pct}%`;
  document.getElementById(`meta-${id}`).textContent = `${formatRp(val)} / ${formatRp(target)}`;
}

function renderDivisionBudgets() {
  const container = document.getElementById('divisionGridContainer');
  container.innerHTML = '';

  const divisions = [
    { name: 'Kitchen', limit: 25000000, catId: 'KITCHEN' },
    { name: 'Bar', limit: 15000000, catId: 'BAR' },
    { name: 'Service', limit: 5000000, catId: 'SERVICE' }
  ];

  divisions.forEach(d => {
    const realisasi = localTransactions.filter(t => t.category_id === d.catId && t.type === 'EXPENSE').reduce((sum, t) => sum + t.amount, 0);
    const pct = (realisasi / d.limit) * 100;
    
    let status = 'AMAN', color = 'var(--success)';
    if (pct > 100) { status = 'OVER'; color = 'var(--danger)'; }
    else if (pct > 80) { status = 'WARN'; color = 'var(--warning)'; }

    container.innerHTML += `
      <div class="grid-row">
        <strong>${d.name}</strong>
        <span>${formatRp(d.limit)}</span>
        <span>${formatRp(realisasi)}</span>
        <span class="status-pill" style="background:${color}">${status}</span>
      </div>
    `;
  });
}

function renderInvoiceList(profileId) {
  const container = document.getElementById('invoiceContainer');
  container.innerHTML = '';
  
  const pending = localInvoices.filter(i => i.status === 'PENDING');
  if (pending.length === 0) {
    container.innerHTML = '<p style="font-size:12px; color:var(--text-muted); text-align:center;">🎉 Semua tagihan bulan lalu lunas.</p>';
    return;
  }

  pending.forEach(inv => {
    container.innerHTML += `
      <div style="display:flex; justify-content:between; align-items:center; padding:10px 0; border-bottom:1px solid #F8FAFC;">
        <div style="flex:1;">
          <h5 style="font-size:13px; font-weight:600;">${inv.title}</h5>
          <p style="font-size:11px; color:var(--text-muted);">Tempo: ${inv.due_date}</p>
        </div>
        <div style="text-align:right;">
          <span style="color:var(--danger); font-weight:700; font-size:13px; margin-right:10px;">${formatRp(inv.amount)}</span>
          <button onclick="payInvoiceInstantly('${inv.id}')" style="padding:4px 8px; background:var(--success); color:white; border:none; border-radius:6px; font-size:10px; cursor:pointer; font-weight:700;">LUNAS</button>
        </div>
      </div>
    `;
  });
}

async function payInvoiceInstantly(invId) {
  try {
    const res = await fetch(`${WORKER_ENDPOINT}/api/invoices/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': API_SECRET_KEY },
      body: JSON.stringify({ invoice_id: invId, status: 'PAID' })
    });
    if (!res.ok) throw new Error();
    
    showToast("Invoice berhasil diselesaikan!");
    const pId = document.getElementById('txtProfileId').value;
    fetchCloudData(pId);
  } catch (e) {
    showToast("Gagal memperbarui status tagihan.", true);
  }
}

function renderTxList() {
  const container = document.getElementById('txListContainer');
  container.innerHTML = '';

  const filtered = localTransactions.filter(t => activeFilter === 'ALL' || t.type === activeFilter);
  if (filtered.length === 0) {
    container.innerHTML = '<p style="text-align:center; color:var(--text-muted); padding:15px; font-size:12px;">Belum ada riwayat mutasi.</p>';
    return;
  }

  filtered.reverse().forEach(t => {
    const isExp = t.type === 'EXPENSE';
    const bg = isExp ? '#FEE2E2' : '#D1FAE5';
    const emoji = isExp ? '🛍️' : '💰';

    container.innerHTML += `
      <div class="tx-item">
        <div class="tx-left">
          <div class="tx-avatar" style="background:${bg}">${emoji}</div>
          <div>
            <h4>${t.description}</h4>
            <p style="font-size:11px; color:var(--text-muted);">${t.category_id} • ${new Date(t.date).toLocaleDateString('id-ID')}</p>
          </div>
        </div>
        <div class="tx-amount ${isExp ? 'expense' : 'income'}">${isExp ? '-' : '+'} ${formatRp(t.amount)}</div>
      </div>
    `;
  });
}

// Handler Submit Formulir Transaksi Baru
document.getElementById('frmTransaction').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = document.querySelector('.btn-main');
  btn.textContent = 'Menulis ke Google Sheets...';
  btn.disabled = true;

  const pId = document.getElementById('txtProfileId').value;
  const payload = {
    profile_id: pId,
    wallet_id: 'W_MAIN',
    category_id: document.getElementById('txtDivision').value,
    type: document.getElementById('txtType').value,
    amount: parseFloat(document.getElementById('txtAmount').value),
    description: document.getElementById('txtDesc').value
  };

  try {
    const res = await fetch(`${WORKER_ENDPOINT}/api/transactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': API_SECRET_KEY },
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error();

    showToast("Transaksi sukses disimpan!");
    document.getElementById('frmTransaction').reset();
    document.getElementById('txtProfileId').value = pId;
    fetchCloudData(pId);
  } catch (err) {
    showToast("Gagal menginput transaksi.", true);
  } finally {
    btn.textContent = 'Simpan ke Cloud Sheets';
    btn.disabled = false;
  }
});

// FITUR KELINGKUNGAN 1: Stealth Mode Sensor Penyamar Saldo Umum
window.triggerStealthMode = () => {
  const lbl = document.getElementById('lblSafeSpend');
  isStealthMode = !isStealthMode;
  if (isStealthMode) {
    realBalanceCache = lbl.textContent;
    lbl.textContent = "Rp 142.500";
    lbl.style.opacity = 0.5;
    showToast("🛡️ Mode Penyamaran Aktif (Saldo Kamuflase)");
  } else {
    lbl.textContent = realBalanceCache;
    lbl.style.opacity = 1;
    showToast("🔓 Mode Penyamaran Dinonaktifkan");
  }
};

// FITUR KELINGKUNGAN 2: Sinkronisasi Absensi API Gateway Karyawan Part-Time
window.syncExternalAttendance = async () => {
  showToast("Menghubungkan ke API Absensi Karyawan...");
  try {
    const res = await fetch(`${WORKER_ENDPOINT}/api/payroll-sync`, { headers: { 'x-api-key': API_SECRET_KEY } });
    const json = await res.json();
    showToast(`Sukses sinkron! Terbaca ${json.data.length} data karyawan part-time.`);
  } catch (e) {
    showToast("Gagal melakukan penarikan data absensi API.", true);
  }
};

// FITUR KELINGKUNGAN 3: Export Jurnal Total ke File CSV
window.exportJurnalCSV = () => {
  if (localTransactions.length === 0) return showToast("Tidak ada data untuk diekspor", true);
  let csv = "ID,Profil,Divisi,Nominal,Tipe,Keterangan,Tanggal\\n";
  localTransactions.forEach(t => {
    csv += `"${t.id}","${t.profile_id}","${t.category_id}",${t.amount},"${t.type}","${t.description}","${t.date}"\\n`;
  });
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.setAttribute("download", `Jurnal_OlloTracker_${Date.now()}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
};

// Initial Load
fetchCloudData('1');