const http = require('http');
const port = process.env.PORT || 8000;

// Server pemancing agar Koyeb tidak mematikan bot
http.createServer((req, res) => {
    res.write('Bot Peternak Unta is Running!');
    res.end();
}).listen(port, () => {
    console.log(`Server listening on port ${port}`);
});

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, delay } = require('@whiskeysockets/baileys');
const pino = require('pino');
const { Boom } = require('@hapi/boom');
// const qrcode = require('qrcode-terminal'); // HAPUS INI

// ==========================================
// KONFIGURASI
// ==========================================
const TARGET_GROUP_ID = '120363426746650307@g.us'; 

// --- PENGATURAN WAKTU INTERVAL ---
const CHECK_INTERVAL = 11 * 60 * 1000;   // Cek Kandang: 11 Menit
const DEPO_INTERVAL = 31 * 60 * 1000;    // Depo All: 31 Menit
const DIVIDEN_INTERVAL = 61 * 60 * 1000; // Dividen: 61 Menit
const KERJA_INTERVAL = 61 * 60 * 1000;   // Kerja: 61 Menit

// --- KONFIGURASI LIMIT LOOPING & RETRY ---
const MAX_LOOP_PER_SESSION = 3; 
let currentLoopCount = 0;       

// Variabel Pengaman (Retry System)
let isWaitingForKandang = false; 
const MAX_RETRIES = 5;           
const RETRY_TIMEOUT = 6000;      

// --- HELPER RANDOM DELAY ---
function getRandomDelay(min = 1000, max = 2000) {
    return Math.floor(Math.random() * (max - min + 1) + min);
}

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_session_group');
    
    const sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        auth: state,
        emitOwnEvents: true, 
        browser: ["AutoFarmer", "Chrome", "1.0.0"]
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        // --- BAGIAN INI DIUBAH (TAMPILKAN RAW QR) ---
        if (qr) {
            console.log("\n==================================================");
            console.log("⚠️ SILAKAN COPY CODE DI BAWAH INI DAN PASTE KE 'goqr.me'");
            console.log("==================================================\n");
            console.log(qr); // <--- INI KODE QR MENTAH
            console.log("\n==================================================\n");
        }
        // ---------------------------------------------

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error = Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('⚠️ Koneksi terputus, mencoba reconnect...', shouldReconnect);
            if (shouldReconnect) connectToWhatsApp();
        } else if (connection === 'open') {
            console.log('✅ BOT TERHUBUNG KE GRUP!');
            console.log(`🎯 Target: ${TARGET_GROUP_ID}`);
            startFarmingLoop(sock);
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message) return;
        if (msg.key.remoteJid !== TARGET_GROUP_ID) return;

        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
        
        // Trigger: Jika ada balasan Kandang
        if (text.includes("🛖 *KANDANG TERNAK*")) {
            console.log("📥 Data Kandang Diterima! Membatalkan retry...");
            
            // --- PENTING: MATIKAN STATUS MENUNGGU ---
            isWaitingForKandang = false; 

            await processKandang(sock, text);
        }
    });
}

function startFarmingLoop(sock) {
    console.log("🚜 Siklus dimulai...");
    
    // 1. Pancingan Awal
    setTimeout(() => {
        currentLoopCount = 0; 
        triggerKandangCheck(sock); // Pakai Fungsi Trigger Baru
    }, getRandomDelay(5000, 7000));

    // 2. Loop Utama KANDANG
    setInterval(() => {
        console.log("⏰ Waktunya cek rutin (!kandang)...");
        currentLoopCount = 0; 
        console.log("🔄 Counter loop di-reset ke 0.");
        triggerKandangCheck(sock); // Pakai Fungsi Trigger Baru
    }, CHECK_INTERVAL);

    // 3. Loop AUTO DEPO
    setInterval(() => {
        console.log("🏦 Waktunya Deposit (!depo all)...");
        sendCommand(sock, '!depo all');
    }, DEPO_INTERVAL);

    // 4. Loop DIVIDEN
    setInterval(() => {
        console.log("💵 Waktunya klaim (!dividen)...");
        sendCommand(sock, '!dividen');
    }, DIVIDEN_INTERVAL);

    // 5. Loop KERJA
    setTimeout(() => {
        setInterval(() => {
            console.log("🔨 Waktunya Kerja (!kerja)...");
            sendCommand(sock, '!kerja');
        }, KERJA_INTERVAL);
    }, getRandomDelay(10000, 15000)); 
}

// ==========================================
// FUNGSI TRIGGER DENGAN RETRY
// ==========================================
async function triggerKandangCheck(sock, attempt = 1) {
    isWaitingForKandang = true;

    console.log(`📡 Mengirim !kandang (Percobaan ${attempt}/${MAX_RETRIES})...`);
    await sendCommand(sock, '!kandang');

    // Pasang Timer 6 Detik
    setTimeout(() => {
        if (isWaitingForKandang) {
            if (attempt < MAX_RETRIES) {
                console.log(`⚠️ Tidak ada respon dalam 6 detik. Mengulangi...`);
                triggerKandangCheck(sock, attempt + 1); 
            } else {
                console.log(`❌ Gagal total setelah ${MAX_RETRIES}x percobaan. Server game mungkin down/lag.`);
                isWaitingForKandang = false; 
            }
        }
    }, RETRY_TIMEOUT);
}

// ==========================================
// LOGIKA OTAK BOT
// ==========================================
async function processKandang(sock, text) {
    const lines = text.split('\n');
    let animalCount = 0;
    
    let healActions = [];
    let sellActions = []; 
    let feedActions = [];

    // --- PARSING TEXT ---
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        
        if (/^\d+\.\s/.test(line)) {
            animalCount++;
            
            const indexStr = line.match(/^(\d+)/)[1];
            const index = parseInt(indexStr);
            const isSick = line.includes("SAKIT");
            
            let weightLine = "";
            if (lines[i+1] && lines[i+1].includes("⚖️")) weightLine = lines[i+1];
            
            let currentWeight = 0;
            let maxWeight = 0;

            if (weightLine) {
                const wMatch = weightLine.match(/Berat:\s+([\d\.]+)\s+\/\s+([\d\.]+)/);
                if (wMatch) {
                    currentWeight = parseFloat(wMatch[1]);
                    maxWeight = parseFloat(wMatch[2]);
                }
            }

            console.log(`🔎 Hewan #${index}: ${currentWeight}/${maxWeight}kg | Sakit: ${isSick}`);

            // 1. OBAT
            if (isSick) {
                healActions.push(`!obati ${index}`);
                continue; 
            }
            // 2. JUAL
            if (currentWeight >= maxWeight) {
                console.log(`💰 Hewan #${index} siap panen!`);
                sellActions.push({ index: index, cmd: `!jualhewan ${index}` });
                animalCount--; 
                continue;
            }
            // 3. MAKAN
            if (currentWeight < maxWeight) {
                feedActions.push(`!pakan ${index} premium`);
            }
        }
    }

    // --- EKSEKUSI AKSI BERURUTAN ---

    // A. OBATI
    for (const cmd of healActions) {
        await delay(getRandomDelay(1500, 2500));
        await sendCommand(sock, cmd);
    }

    // B. JUAL (Urut Index Besar ke Kecil)
    if (sellActions.length > 0) {
        sellActions.sort((a, b) => b.index - a.index);
        console.log("📉 Urutan Jual:", sellActions.map(a => a.index)); 

        for (const action of sellActions) {
            await delay(getRandomDelay(2000, 3000)); 
            await sendCommand(sock, action.cmd);
        }
    }

    // C. MAKAN
    for (const cmd of feedActions) {
        await delay(getRandomDelay(1000, 2000));
        await sendCommand(sock, cmd);
    }

    // D. BELI UNTA
    await delay(getRandomDelay(2000, 3000));
    const emptySlots = 8 - animalCount;
    if (emptySlots > 0) {
        console.log(`🛒 Ada ${emptySlots} slot kosong. Membeli Unta...`);
        for (let j = 0; j < emptySlots; j++) {
            await delay(getRandomDelay(3000, 4500)); 
            await sendCommand(sock, `!belihewan unta`);
        }
    }

    // --- CEK ULANG (DENGAN FUNGSI TRIGGER BARU) ---
    if (feedActions.length > 0) {
        if (currentLoopCount < MAX_LOOP_PER_SESSION) {
            currentLoopCount++; 
            console.log(`🔄 [Loop ${currentLoopCount}/${MAX_LOOP_PER_SESSION}] Cek kandang lagi...`);
            
            await delay(getRandomDelay(4000, 6000)); 
            // Ganti sendCommand manual dengan fungsi trigger pengaman
            triggerKandangCheck(sock); 
        } else {
            console.log(`🛑 Batas loop tercapai (${MAX_LOOP_PER_SESSION}x). Istirahat.`);
        }
    }
}

// Helper: Kirim pesan
async function sendCommand(sock, text) {
    await sock.sendPresenceUpdate('composing', TARGET_GROUP_ID);
    const typingTime = getRandomDelay(1000, 2000);
    await delay(typingTime);
    await sock.sendMessage(TARGET_GROUP_ID, { text: text });
    await sock.sendPresenceUpdate('paused', TARGET_GROUP_ID);
}

connectToWhatsApp();
