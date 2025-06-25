const { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const { platform } = require('os');
const { json } = require('stream/consumers');

// Serve this from Express later
const placeholderPath = path.join(__dirname, 'assets', 'placeholder.png');
const store = {};
const accessToken = "23ba056faf7d8b23aad142699b0624a177a225a0";

const getMessage = key => {
    const { id } = key;
    if (store[id])
        return store[id].message
}



function stripDeviceId(jid) {
    return jid?.replace(/:\d+@/, '@');
}

function getAllowedGroups(userId) {
    const filePath = path.join(__dirname, 'groupstoread', `${userId}.json`);
    try {
        const data = fs.readFileSync(filePath, 'utf-8');
        return JSON.parse(data); // returns an array of group JIDs
    } catch (err) {
        console.error(`❌ Failed to read group list for ${userId}:`, err.message);
        return []; // return empty if file missing or invalid
    }
}

async function initializeWhatsAppStore() {
    const activeUsersPath = path.join(__dirname, 'activeUsers.json');
    const authRoot = path.join(__dirname, 'auth');

    if (!fs.existsSync(activeUsersPath)) {
        console.warn('⚠️ activeUsers.json not found. Skipping session restore.');
        return;
    }

    const activeUserIds = JSON.parse(fs.readFileSync(activeUsersPath, 'utf-8'));

    for (const userId of activeUserIds) {
        const userAuthPath = path.join(authRoot, userId);

        if (!fs.existsSync(userAuthPath) || fs.readdirSync(userAuthPath).length === 0) {
            console.warn(`⚠️ Auth folder missing for user: ${userId}`);
            continue;
        }

        try {
            const { state } = await useMultiFileAuthState(userAuthPath);
            const { version } = await fetchLatestBaileysVersion();

            const sock = makeWASocket({
                auth: state,
                version: version,
            });

            store[userId] = sock;

            sock.ev.process(async event => {
                if (event['connection.update']) {
                    const { connection, lastDisconnect } = event['connection.update'];

                    // Reconnect logic
                    if (connection === 'close') {
                        if (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) {
                            connectwhatsapp(userId); // Reconnect if not logged out
                        } else if (lastDisconnect?.error?.output?.statusCode == DisconnectReason.loggedOut) {
                            console.log("User logged out from WhatsApp");

                            // Cleanup logic
                            try {
                                // 1. Delete auth folder for user
                                const authFolder = path.join(__dirname, 'auth', userId);
                                const statsFolder = path.join(__dirname, 'countstats', userId);
                                const qrFolder = path.join(__dirname, 'qr', userId);
                                const groupFilePath = path.join(__dirname, 'groupstoread', `${userId}.json`);
                                if (fs.existsSync(groupFilePath)) {
                                    fs.rmSync(groupFilePath, { recursive: true, force: true });
                                    console.log(`Deleted read groups file for user ${userId}`);
                                }
                                if (fs.existsSync(qrFolder)) {
                                    fs.rmSync(qrFolder, { recursive: true, force: true });
                                    console.log(`Deleted qr folder for user ${userId}`);
                                }
                                /*if (fs.existsSync(statsFolder)) {
                                    fs.rmSync(statsFolder, { recursive: true, force: true });
                                    console.log(`Deleted stats folder for user ${userId}`);
                                }*/
                                if (fs.existsSync(authFolder)) {
                                    fs.rmSync(authFolder, { recursive: true, force: true });
                                    console.log(`Deleted auth folder for user ${userId}`);
                                }

                                // 2. Remove from activeUsers.json
                                const activeUsersPath = path.join(__dirname, 'activeUsers.json');
                                if (fs.existsSync(activeUsersPath)) {
                                    const data = JSON.parse(fs.readFileSync(activeUsersPath, 'utf-8'));
                                    const updated = data.filter(id => id !== userId);
                                    fs.writeFileSync(activeUsersPath, JSON.stringify(updated, null, 2));
                                    console.log(`🗂️ Removed ${userId} from activeUsers.json`);
                                }

                                // 3. Delete socket from store (if applicable)
                                if (store[userId]) {
                                    delete store[userId];
                                    console.log(`Deleted socket from store for user ${userId}`);
                                }
                            } catch (err) {
                                console.error("Error during logout cleanup:", err);
                            }
                        }
                    }

                }
                if (event['messages.upsert']) {
                    const { messages } = event['messages.upsert'];
                    const allowedGroups = getAllowedGroups(userId); // Load once per event
                    messages.forEach(async message => {
                        const senderId = message.key.participant;
                        console.log(`Received message from: ${senderId}`);
                        const remoteJid = message.key.remoteJid;
                        const myJid = store[userId]?.user?.id;
                        console.log(`My JID: ${myJid}, Remote JID: ${remoteJid}`);
                        if (stripDeviceId(myJid) === stripDeviceId(senderId)) {
                            return; // Skip own messages
                        }
                        else {
                            const isGroup = remoteJid.endsWith('@g.us');
                            if (isGroup) {
                                if (isGroup && !allowedGroups.includes(remoteJid)) {
                                    return; // Ignore unwanted groups
                                }
                                else {
                                    let msgContent = '[Unsupported message type]';
                                    if (message.message?.conversation) {
                                        msgContent = message.message.conversation;
                                    } else if (message.message?.extendedTextMessage?.text) {
                                        msgContent = message.message.extendedTextMessage.text;
                                    }
                                    console.log(`📩 ${remoteJid}: ${msgContent}`);
                                    // 🚀 API call
                                    try {
                                         await axios.post('http://localhost:8080/reader/message', {
                                         userId: userId,
                                         groupId: remoteJid,
                                         message: msgContent,
                                         platform:"whatsapp"
                                         });
                                        console.log(`✅ Message forwarded to API`);
                                    }
                                    catch (err) {
                                        if (err.response) {
                                            // Log the full error response for debugging
                                            console.error(`❌ Failed to forward message:`, err.message, 'Response:', JSON.stringify(err.response.data));
                                        } else {
                                            console.error(`❌ Failed to forward message:`, err.message);
                                        }
                                    }
                                }
                            }
                        }
                    });
                }


            });
            console.log(`✅ Restored session for user: ${userId}`);
        } catch (err) {
            console.error(`❌ Failed to restore session for ${userId}: ${err.message}`);
        }
    }
}

async function connectwhatsapp(userId) {
    const authFolder = path.join(__dirname, 'auth', userId);
    const statsFolder = path.join(__dirname, 'countstats', userId); // Create folder for each user
    const readgroupsPath = path.join(__dirname, 'groupstoread', `${userId}.json`);
    if (!fs.existsSync(readgroupsPath)) {
        fs.writeFileSync(readgroupsPath, JSON.stringify([]), 'utf8'); // Create an empty file if it doesn't exist
    }
    const filePath = path.join(statsFolder, 'links.json');
    const qrPath = path.join(__dirname, 'qr', userId);
    if (!fs.existsSync(qrPath)) {
        fs.mkdirSync(qrPath, { recursive: true });
    }
    const qrImagePath = path.join(qrPath, 'qr.png');

    // Ensure the folder exists
    if (!fs.existsSync(statsFolder)) {
        fs.mkdirSync(statsFolder, { recursive: true });
    }

    // Create the file only if it doesn't exist
    if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, JSON.stringify([], null, 2), 'utf8');
        console.log('links.json created successfully with []');
    } else {
        console.log('links.json already exists');
    }


    if (!fs.existsSync(authFolder)) {
        fs.mkdirSync(authFolder, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(authFolder);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        auth: state,
        version: version,
        printQRInTerminal: false // Disable terminal print
    });

    store[userId] = sock; // Store the socket for this user


    const userfilePath = path.join(__dirname, 'users.json');
    let users = [];
    if (fs.existsSync(userfilePath)) {
        users = JSON.parse(fs.readFileSync(userfilePath, 'utf-8'));
    }
    users.push({ userId, timestamp: Date.now() }); // Add new entry
    fs.writeFileSync(userfilePath, JSON.stringify(users, null, 2));


    sock.ev.process(async event => {
        if (event['connection.update']) {
            const { connection, lastDisconnect, qr } = event['connection.update'];

            // Handle QR Code
            if (qr) {
                try {
                    await QRCode.toFile(qrImagePath, qr);
                    console.log("QR Code updated and saved at:", qrImagePath);
                } catch (err) {
                    console.error("Failed to generate QR code image:", err);
                }
            }

            // Reconnect logic
            if (connection === 'close') {
                if (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) {
                    connectwhatsapp(userId); // Reconnect if not logged out
                } else if (lastDisconnect?.error?.output?.statusCode == DisconnectReason.loggedOut) {
                    console.log("User logged out from WhatsApp");

                    // Cleanup logic
                    try {
                        // 1. Delete auth folder for user
                        const authFolder = path.join(__dirname, 'auth', userId);
                        const statsFolder = path.join(__dirname, 'countstats', userId);
                        const qrFolder = path.join(__dirname, 'qr', userId);
                        const readGroupsPath = path.join(__dirname, 'groupstoread', `${userId}.json`);
                        if (fs.existsSync(readGroupsPath)) {
                            fs.rmSync(readGroupsPath, { recursive: true, force: true });
                            console.log(`Deleted read groups file for user ${userId}`);
                        }
                        if (fs.existsSync(qrFolder)) {
                            fs.rmSync(qrFolder, { recursive: true, force: true });
                            console.log(`Deleted qr folder for user ${userId}`);
                        }
                        /*if (fs.existsSync(statsFolder)) {
                            fs.rmSync(statsFolder, { recursive: true, force: true });
                            console.log(`Deleted stats folder for user ${userId}`);
                        }*/
                        if (fs.existsSync(authFolder)) {
                            fs.rmSync(authFolder, { recursive: true, force: true });
                            console.log(`Deleted auth folder for user ${userId}`);
                        }

                        // 2. Remove from activeUsers.json
                        const activeUsersPath = path.join(__dirname, 'activeUsers.json');
                        if (fs.existsSync(activeUsersPath)) {
                            const data = JSON.parse(fs.readFileSync(activeUsersPath, 'utf-8'));
                            const updated = data.filter(id => id !== userId);
                            fs.writeFileSync(activeUsersPath, JSON.stringify(updated, null, 2));
                            console.log(`🗂️ Removed ${userId} from activeUsers.json`);
                        }

                        // 3. Delete socket from store (if applicable)
                        if (store[userId]) {
                            delete store[userId];
                            console.log(`Deleted socket from store for user ${userId}`);
                        }
                    } catch (err) {
                        console.error("Error during logout cleanup:", err);
                    }
                }
            }

        }

        if (event['creds.update']) {
            await saveCreds();
            fs.copyFileSync(placeholderPath, qrImagePath); // Overwrites qr.png with placeholder.png
            const filePath = path.join(__dirname, 'activeUsers.json');
            const userfilePath = path.join(__dirname, 'users.json');
            const qrPath = path.join(__dirname, 'qr', userId);
            let users = [];
            if (fs.existsSync(userfilePath)) {
                users = JSON.parse(fs.readFileSync(userfilePath, 'utf-8'));
            }
            users = users.filter(user => user.userId !== userId); // Remove old entry
            fs.writeFileSync(userfilePath, JSON.stringify(users, null, 2));

            let activeUsers = [];
            if (fs.existsSync(filePath)) {
                activeUsers = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            }
            if (!activeUsers.includes(userId)) {
                activeUsers.push(userId);
                fs.writeFileSync(filePath, JSON.stringify(activeUsers, null, 2));
            }
            ///if(fs.existsSync(qrPath)) {
            // fs.rmSync(qrPath, { recursive: true, force: true });
            //  }
        }

        if (event['messages.upsert']) {
            const { messages } = event['messages.upsert'];
            const allowedGroups = getAllowedGroups(userId); // Load once per event
            messages.forEach(async message => {
                const senderId = message.key.participant;
                console.log(`Received message from: ${senderId}`);
                const remoteJid = message.key.remoteJid;
                const myJid = store[userId]?.user?.id;
                console.log(`My JID: ${myJid}, Remote JID: ${remoteJid}`);
                if (stripDeviceId(myJid) === stripDeviceId(senderId)) {
                    return; // Skip own messages
                }
                else {
                    const isGroup = remoteJid.endsWith('@g.us');
                    if (isGroup) {
                        if (isGroup && !allowedGroups.includes(remoteJid)) {
                            return; // Ignore unwanted groups
                        }
                        else {
                            let msgContent = '[Unsupported message type]';
                            if (message.message?.conversation) {
                                msgContent = message.message.conversation;
                            } else if (message.message?.extendedTextMessage?.text) {
                                msgContent = message.message.extendedTextMessage.text;
                            }
                            console.log(`📩 ${remoteJid}: ${msgContent}`);
                            // 🚀 API call
                            try {
                                 await axios.post('http://localhost:8080/reader/message', {
                                 userId: userId,
                                 groupId: remoteJid,
                                 message: msgContent,
                                 platform:"whatsapp"
                                });
                                console.log(`✅ Message forwarded to API`);
                            }
                            catch (err) {
                                        if (err.response) {
                                            // Log the full error response for debugging
                                            console.error(`❌ Failed to forward message:`, err.message, 'Response:', JSON.stringify(err.response.data));
                                        } else {
                                            console.error(`❌ Failed to forward message:`, err.message);
                                        }
                                    }
                        }
                    }
                }
            });
        }

    });
}

async function fetchGroups(userId) {
    let sock = store[userId];
    if (!sock) {
        console.error('Socket not found for user:', userId);
        return { error: 'Socket not found for user. Please log in first.' };
    }

    // Retry logic with exponential backoff for rate-limited requests
    let attempt = 0;
    const maxRetries = 3;
    while (attempt < maxRetries) {
        try {
            // Use Promise.race to timeout the group fetch if it's too slow
            const groupMetadata = await Promise.race([
                sock.groupFetchAllParticipating(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Timed Out')), 15000)) // Timeout after 15 seconds
            ]);

            // Fetch groups if the operation is successful
            const groups = Object.entries(groupMetadata).map(([id, metadata]) => ({
                id: metadata.id,
                name: metadata.subject
            }));

            return groups; // Return the list of groups

        } catch (err) {
            if (err.message.includes('rate-overlimit')) {
                attempt++;
                const waitTime = Math.pow(2, attempt) * 1000; // Exponential backoff
                console.log(`Rate limit hit. Retrying in ${waitTime / 1000} seconds...`);
                await new Promise(resolve => setTimeout(resolve, waitTime)); // Wait before retry
            } else if (err.message === 'Timed Out') {
                console.error('Request timed out while fetching groups');
                return { error: 'Request timed out while fetching groups. Please try again later.' };
            } else {
                console.error('Error fetching groups:', err);
                return { error: 'Failed to fetch groups' }; // Handle other errors
            }
        }
    }

    return { error: 'Failed to fetch groups after multiple attempts. Please try again later.' }; // Return after retries exceed
}

function deleteUnusedSockets() {
    console.log('🧹 Cleaning up unused sockets...');
    const usersPath = path.join(__dirname, 'users.json');
    const authRoot = path.join(__dirname, 'auth');
    const statsroot = path.join(__dirname, 'countstats');
    const qrRoot = path.join(__dirname, 'qr');

    if (!fs.existsSync(usersPath)) return;

    const now = Date.now();
    const timeout = 10 * 60 * 1000; // 10 minutes
    let users = [];

    try {
        users = JSON.parse(fs.readFileSync(usersPath, 'utf-8') || '[]');
    } catch (err) {
        console.error('Failed to parse users.json:', err.message);
        return;
    }

    const remainingUsers = [];

    for (const entry of users) {
        const { userId, timestamp } = entry;
        const age = now - timestamp;

        if (age > timeout) {
            // Delete socket from store
            if (store[userId]) {
                try {
                    store[userId].end(); // Gracefully end socket
                } catch (e) {
                    console.warn(`Error closing socket for ${userId}:`, e.message);
                }
                delete store[userId];
                console.log(`🧹 Removed unused socket for ${userId}`);
            }

            // Delete auth folder
            const userAuthPath = path.join(authRoot, userId);
            const userStatsPath = path.join(statsroot, userId);
            const groupFilePath = path.join(__dirname, 'groupstoread', `${userId}.json`);
            const userQrPath = path.join(qrRoot, userId);
            if (fs.existsSync(userAuthPath) && fs.existsSync(userStatsPath) && fs.existsSync(userQrPath)&& fs.existsSync(groupFilePath)) {
                fs.rmSync(userAuthPath, { recursive: true, force: true });
                fs.rmSync(userStatsPath, { recursive: true, force: true });
                fs.rmSync(userQrPath, { recursive: true, force: true });
                fs.rmSync(groupFilePath, { recursive: true, force: true });
                console.log(`🗑️ Deleted auth, stats, groups and qr folder for ${userId}`);
            }
        } else {
            remainingUsers.push(entry); // Still valid
        }
    }

    // Write back only valid users
    fs.writeFileSync(usersPath, JSON.stringify(remainingUsers, null, 2));
}

async function sendMessageToGroups(userId, groupJids, message) {
    const sock = store[userId];
    if (!sock) {
        console.error(`❌ No active socket found for user ${userId}`);
        return;
    }
    
    for (const groupJid of groupJids) {
        try {
           // await sock.assertSessions([groupJid], true);
            await sock.sendMessage(groupJid, { text: message });
            console.log(`✅ Message sent to ${groupJid}`);
        } catch (err) {
            console.error(`❌ Failed to send message to ${groupJid}:`, err.message);
        }
    }
}

function extractUrls(text) {
    if (typeof text !== 'string') return [];
    // Match URLs with http, https, ftp, www, or just domain.tld
    const urlRegex = /\b((?:https?:\/\/|http:\/\/|ftp:\/\/|www\.)[^\s/$.?#].[^\s]*|(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}(?:\/[^\s]*)?)/gi;
    return text.match(urlRegex) || [];
}

async function shortenUrlWithBitly(longUrl, accessToken) {
    try {
        console.log("Bitly Token :", fs.accessToken);
        const response = await axios.post(
            'https://api-ssl.bitly.com/v4/shorten',
            { long_url: longUrl },
            {
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                }
            }
        );
        console.log("Bitly Response:", response.data);
        return response.data.link;
    } catch (error) {
        throw new Error(`Bitly API Error: ${error.response.data.message}`);
    }
}

async function processMessageWithTracking(userId, message, whatsapp, telegram) {
    const userFolder = path.join(__dirname, 'countstats', userId);
    const filePath = path.join(userFolder, 'links.json');
    let messagew = message;
    let messaget = message;
    console.log("whatsapp unprocessed:", messagew);
    console.log("telegram unprocessed:", messaget);
    console.log("message:", message);

    // Ensure folder exists
    if (!fs.existsSync(userFolder)) {
        fs.mkdirSync(userFolder, { recursive: true });
    }

    // Read existing links or initialize
    let data = [];
    if (fs.existsSync(filePath)) {
        data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }

    // Extract URLs from the original messagew (not message object)
    const urls = extractUrls(messagew);

    for (const originalUrl of urls) {
        let existing = data.find(entry => entry.url === originalUrl);
        let wplatform = "whatsapp";
        let tplatform = "telegram";
        let linkId;
        let bitlyUrl = "{}";

        if (existing) {
            linkId = existing.id;
            bitlyUrl = existing.bitly;
        } else {
            linkId = uuidv4();
            // bitlyUrl = await shortenUrlWithBitly(originalUrl, accessToken);
            data.push({
                id: linkId,
                url: originalUrl,
                bitly: bitlyUrl,
                count: 0,
                TelegramCount: 0,
                WhatsappCount: 0,
                Telegram: telegram,
                Whatsapp: whatsapp,
                timestamp: Date.now()
            });
        }

        const trackingUrlw = `http://localhost:5000/click/${userId}/${linkId}/${wplatform}`;
        const trackingUrlt = `http://localhost:5000/click/${userId}/${linkId}/${tplatform}`;

        // Replace only in messagew and messaget separately
        messagew = messagew.replace(originalUrl, trackingUrlw);
        messaget = messaget.replace(originalUrl, trackingUrlt);
    }
    
    // Save updated data
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    console.log("whatsapp processed:", messagew);
    console.log("telegram processed:", messaget);
    // Return the modified messages as an object
    return { W: messagew, T: messaget };
}

function separator(message) {
    const urls = extractUrls(message);
    return urls;
}

function incrementLinkClick(userId, linkId,platform) {
    const folderPath = path.join(__dirname, 'countstats', userId);
    const filePath = path.join(folderPath, 'links.json');

    if (!fs.existsSync(filePath)) {
        throw new Error("Tracking file not found");
    }

    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

    const link = data.find(entry => entry.id === linkId);

    if (!link) {
        throw new Error("Link not found");
    }

    link.count = (link.count || 0) + 1;
    if (platform === "whatsapp") {
        link.WhatsappCount = (link.WhatsappCount || 0) + 1;
    }
    else if (platform === "telegram") {
        link.TelegramCount = (link.TelegramCount || 0) + 1;
    }

    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));

    return link.url;
}

function getStats(userId) {
    return new Promise((resolve, reject) => {
        const statsPath = path.join(__dirname, 'countstats', userId, 'links.json');
        fs.readFile(statsPath, 'utf-8', (err, data) => {
            if (err) return reject(err);
            try {
                const stats = JSON.parse(data);
                resolve(stats); // Must be an array of JSON objects
            } catch (parseErr) {
                reject(parseErr);
            }
        });
    });
}

function getLinkStatus(userId, link) {
    const statsFolderPath = path.join(__dirname, 'countstats', userId);
    const filePath = path.join(statsFolderPath, 'links.json');

    try {
        if (!fs.existsSync(filePath)) {
            console.warn(`⚠️ No stats file found for user: ${userId}`);
            return { status: 'not shared' };
        }

        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

        const match = data.find(item => item.url === link);

        if (match) {
            return { status: 'Already shared' };
        } else {
            return { status: 'Not shared' };
        }

    } catch (err) {
        console.error(`❌ Error reading stats file for ${userId}:`, err.message);
        return { status: 'not shared' };
    }
}

function parseToMillis(dateString) {
    const [day, month, year] = dateString.split('-');
    const date = new Date(`${year}-${month}-${day}`);
    return date.getTime();
}

function getLinks(userId, date) {
    newdate = parseToMillis(date);
    return new Promise((resolve, reject) => {
        const statsPath = path.join(__dirname, 'countstats', userId, 'links.json');
        fs.readFile(statsPath, 'utf-8', (err, data) => {
            if (err) return reject(err);
            try {
                const stats = JSON.parse(data); // Should be an array
                const filteredStats = stats.filter(item => item.timestamp >= newdate);
                resolve(filteredStats);
            } catch (parseErr) {
                reject(parseErr);
            }
        });
    });
}

async function setGroups(userId, groups) {
    const groupFilePath = path.join(__dirname, 'groupstoread', `${userId}.json`);
    try {
        // Overwrite the file directly with the new groups array
        fs.writeFileSync(groupFilePath, JSON.stringify(groups, null, 2), 'utf8');
        console.log(`✅ Groups updated for user ${userId}`);
    } catch (err) {
        console.error(`❌ Failed to update groups for user ${userId}:`, err.message);
        return { error: 'Failed to update groups' };
    }
}
async function logoutUser(userId) {
    const authPath = path.join(__dirname, 'auth', userId);
    const statsPath = path.join(__dirname, 'countstats', userId);
    const qrPath = path.join(__dirname, 'qr', userId);
    const activeUsersPath = path.join(__dirname, 'activeUsers.json');
    const groupFilePath = path.join(__dirname, 'groupstoread', `${userId}.json`);

    const socket = store[userId];
    if (!socket) {
        console.warn(`⚠️ No active socket found for user: ${userId}`);
        return { error: 'No active socket found for user. Please log in first.' };
    }

    try {
        await socket.logout();
        delete store[userId];
        console.log(`✅ Logged out socket for user: ${userId}`);
    } catch (err) {
        console.error(`❌ Error during logout for ${userId}:`, err.message);
        return { error: 'Failed to log out' };
    }

    // Delete auth folder
    try {
        fs.rmSync(authPath, { recursive: true, force: true });
        //fs.rmSync(statsPath, { recursive: true, force: true });
        fs.rmSync(qrPath, { recursive: true, force: true });
        fs.rmSync(groupFilePath, { recursive: true, force: true });
        console.log(`🗑️ Deleted auth folder for user: ${userId}`);
        //console.log(`🗑️ Deleted stats folder for user: ${userId}`);
        console.log(`🗑️ Deleted qr folder for user: ${userId}`);
        console.log(`🗑️ Deleted read groups file for user: ${userId}`);
    } catch (err) {
        console.error(`❌ Failed to delete auth folder for ${userId}:`, err.message);
    }

    // Remove from activeUsers.json
    try {
        if (fs.existsSync(activeUsersPath)) {
            const data = JSON.parse(fs.readFileSync(activeUsersPath, 'utf-8'));
            const updated = data.filter(id => id !== userId);
            fs.writeFileSync(activeUsersPath, JSON.stringify(updated, null, 2));
            console.log(`🗂️ Removed ${userId} from activeUsers.json`);
        }
        return { success: 'Sucessfully Logged Out Whatsapp' };
    } catch (err) {
        console.error(`❌ Failed to update activeUsers.json:`, err.message);
    }
}

module.exports = {
    connectwhatsapp,
    fetchGroups,
    initializeWhatsAppStore,
    deleteUnusedSockets,
    logoutUser,
    sendMessageToGroups,
    incrementLinkClick,
    getStats,
    getLinks,
    getLinkStatus,
    separator,
    shortenUrlWithBitly,
    setGroups,
    processMessageWithTracking
};
