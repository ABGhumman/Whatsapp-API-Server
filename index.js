const express = require('express');
const path = require('path');
const fs = require('fs'); // ✅ You missed this import
const { fetchGroups, connectwhatsapp, initializeWhatsAppStore, deleteUnusedSockets, logoutUser, sendMessageToGroups, incrementLinkClick } = require('./connectwhatsapp');

const app = express();
app.use(express.json());
const PORT = 5000;

// Serve static files from the public directory

app.use(express.static(path.join(__dirname, 'public')));

// Serve QR images from /qr route
app.use('/qr', express.static(path.join(__dirname, 'public')));

// Route to trigger WhatsApp connection
app.get('/connect', (req, res) => {
    const userId = req.query.userId;

    if (!userId) {
        return res.status(400).send('User ID is required.');
    }

    const userFolderPath = path.join(__dirname, 'auth', userId);
    if (!fs.existsSync(userFolderPath) || fs.readdirSync(userFolderPath).length === 0) {
        connectwhatsapp(userId)
            .then(() => {
                res.send('WhatsApp connection started. Scan QR at /qr/qr.png');
            })
            .catch(err => {
                console.error("Error starting WhatsApp connection:", err);
                res.status(500).send('Failed to start WhatsApp connection.');
            });
    } else {
        res.send('Already connected.');
    }
});

// Route to fetch WhatsApp groups for a user
app.get('/fetchGroups', (req, res) => {
    const userId = req.query.userId;

    if (!userId) {
        return res.status(400).send('User ID is required.');
    }

    const userFolderPath = path.join(__dirname, 'auth', userId);

    if (fs.existsSync(userFolderPath) && fs.readdirSync(userFolderPath).length > 0) {
        fetchGroups(userId)
            .then(groups => {
                if (groups.error) {
                    return res.status(500).send(groups.error);
                }
                res.json(groups);
            })
            .catch(err => {
                console.error("Error fetching groups:", err);
                res.status(500).send('Failed to fetch WhatsApp groups.');
            });
    } else {
        res.send('Please log in first by scanning the QR code.');
    }
});

app.post('/sendmessage', async (req, res) => {
    const { userId, message, groupJids } = req.body;

    // Validate input
    if (!userId || !message || !Array.isArray(groupJids)) {
        return res.status(400).json({ error: "Missing or invalid userId, message, or groupJids" });
    }
    const userFolderPath = path.join(__dirname, 'auth', userId);
    if (fs.existsSync(userFolderPath) && fs.readdirSync(userFolderPath).length > 0) {
        try {
            await sendMessageToGroups(userId, groupJids, message);
            return res.status(200).json({ success: true, message: "Messages sent successfully." });
        } catch (err) {
            console.error("Error sending messages:", err);
            return res.status(500).json({ success: false, error: "Failed to send messages" });
        }
    } else {
        res.send('Please log in first by scanning the QR code.');
    }
});

app.get('/click/:userId/:linkId', (req, res) => {
    const { userId, linkId } = req.params;
    if (!userId || !linkId) {
        return res.status(400).send('User ID and Link ID are required.');
    }

    const userFolderPath = path.join(__dirname, 'auth', userId);
    if (!fs.existsSync(userFolderPath) || fs.readdirSync(userFolderPath).length === 0) {
        return res.status(403).send('User is not logged in.');
    }
    else{
    try {
        const url = incrementLinkClick(userId, linkId);
        return res.redirect(url);
    } catch (err) {
        console.error(err);
        return res.status(404).send(err.message);
    }
}
});

app.get('/logout', (req, res) => {
    const userId = req.query.userId;

    if (!userId) {
        return res.status(400).send('User ID is required.');
    }

    const userFolderPath = path.join(__dirname, 'auth', userId);

    if (fs.existsSync(userFolderPath) && fs.readdirSync(userFolderPath).length > 0) {
        logoutUser(userId)
            .then(success => {
                res.json(success);
            })
            .catch(err => {
                console.error("Error logging out:", err);
                res.status(500).send('Failed to Logout WhatsApp.');
            });
    } else {
        res.send('Please log in first by scanning the QR code.');
    }
});

// Start the server
app.listen(PORT, () => {
    initializeWhatsAppStore(); // Initialize WhatsApp store
    console.log(`Server running at https://api-test-production-72da.up.railway.app/`);

    // Set up a periodic check for users.json
    const usersFilePath = path.join(__dirname, 'users.json');
    setInterval(() => {
        fs.readFile(usersFilePath, 'utf-8', (err, data) => {
            if (err) {
                console.error('Error reading users.json:', err);
                return;
            }

            try {
                const users = JSON.parse(data);
                if (Object.keys(users).length > 0) {
                    deleteUnusedSockets(); // Only call if not empty
                }
            } catch (e) {
                console.error('Error parsing users.json:', e);
            }
        });
    }, 3000);
});
