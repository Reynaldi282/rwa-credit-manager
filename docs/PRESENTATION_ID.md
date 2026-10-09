# Naskah Presentasi 3 Menit — RWA Credit Manager

> Bahasa Indonesia · ±420 kata · target durasi 3:00. Kolom kanan = apa yang ditampilkan di layar.

---

### 0:00 – 0:20 · Pembuka

**Ucapan:**
"Bayangkan Anda punya ETF S&P 500 dalam bentuk token, lalu meminjam stablecoin dengan jaminan token itu. Pasar turun
20% dalam semalam. Saat Anda bangun, posisi Anda sudah dilikuidasi dan Anda kena penalti. Kami membangun
**RWA Credit Manager** supaya hal itu tidak terjadi."

**Layar:** Halaman dashboard, tagline *Protect Your Onchain Collateral*.

### 0:20 – 0:50 · Masalah

**Ucapan:**
"Aset dunia nyata yang ditokenisasi, seperti saham dan obligasi, mulai dipakai sebagai jaminan di DeFi, misalnya di
Morpho Blue. Masalahnya, likuidasi di DeFi itu otomatis dan tanpa ampun. Begitu LTV melewati batas, posisi bisa
dilikuidasi siapa saja. Peminjam harus memantau harga 24 jam sehari, dan itu tidak realistis."

**Layar:** Kartu *Current loan-to-value*: 60%, batas likuidasi Morpho 77%, harga likuidasi $389,61.

### 0:50 – 1:20 · Solusi

**Ucapan:**
"Solusi kami adalah smart contract **RWASafetyGuard**. Pengguna menyetor cadangan stablecoin dan menentukan kebijakan,
misalnya: *kalau LTV menyentuh 70%, turunkan kembali ke 65%*. Kontrak membaca utang langsung dari Morpho, termasuk
bunganya, dan membaca harga dari oracle market. Begitu batas tercapai, kontrak **membayar sebagian utang langsung ke
Morpho** atas nama pengguna. Semuanya onchain, tanpa admin, dan dana satu pengguna tidak bisa dipakai untuk pengguna lain."

**Layar:** Panel *Protection settings* (trigger 70%, target 65%, reserve $200), lalu *Risk simulator* digeser ke −20%.

### 1:20 – 2:30 · Demo langsung

**Ucapan:**
"Sekarang demo nyata. Saya punya jaminan senilai $2.000 dan utang $1.200 di Morpho Blue, jadi LTV-nya 60%.
Sekarang kita simulasikan pasar jatuh 20% dengan oracle testnet." *(klik **Drop price 20%**)*
"Nilai jaminan jadi $1.600 dan LTV naik ke 75%, tinggal 2% lagi dari batas likuidasi 77%.
Keeper kami mendeteksinya dan memanggil `executeProtection`." *(tunggu keeper, atau klik **Execute protection**)*
"Selesai. Kontrak membayar 160 USDC ke Morpho, utang turun dari $1.200 ke $1.040, dan LTV kembali ke 65%.
Ini transaksi nyata. Di riwayat transaksi ada hash-nya dan event `ProtectionExecuted`, dan di transaksi yang sama ada
event `Repay` dari Morpho."

**Layar:** LTV 75% → 65%, toast transaksi, tabel *Transaction history* (link *Event log* di Etherscan bila di Sepolia).

### 2:30 – 2:50 · Teknologi & kejujuran

**Ucapan:**
"Integrasi Morpho Blue-nya asli, memakai deployment resmi di Sepolia dan AdaptiveCurveIrm. Yang kami mock hanya token
RWA, stablecoin, dan oracle harganya, dan semuanya jelas berlabel *testnet*. Kontrak ini sudah diuji dengan 55 tes
Foundry, termasuk fuzz, invariant, uji reentrancy, dan simulasi di fork Sepolia. Satu catatan penting: perlindungan otomatis
bergantung pada keeper yang online. Kalau keeper mati, pengguna tetap bisa mengeksekusi sendiri."

**Layar:** Kartu *Contracts & what is real*.

### 2:50 – 3:00 · Penutup

**Ucapan:**
"RWA Credit Manager membuat pinjaman berbasis aset dunia nyata lebih aman: deleverage otomatis, dikontrol smart
contract, dan bisa diverifikasi onchain. Terima kasih."

**Layar:** Kembali ke ringkasan posisi: LTV 65%, status *Healthy*.

---

**Tips presenter**
- Jalankan *Run guided setup* sebelum naik panggung. Saat demo, cukup klik *Drop price 20%* lalu eksekusi.
- Siapkan cadangan: kalau RPC lambat, jalankan `npm run e2e:local` di terminal sebagai bukti langsung.
- Jangan sebut alamat kontrak atau hash transaksi Sepolia sebelum benar-benar ter-deploy dan terverifikasi.
