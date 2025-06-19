const express = require('express');
const path = require('path');
const fs = require('fs');
const { fetchGroups,
    connectwhatsapp,
    initializeWhatsAppStore,
    deleteUnusedSockets,
    logoutUser,
    sendMessageToGroups,
    incrementLinkClick,
    getStats, 
    getLinks,
    getLinkStatus,
    separator
 } = require('./connectwhatsapp');
const { url } = require('inspector');

const app = express();
const cors = require('cors');
app.use(cors());
app.use('/qr', cors(), express.static('path_to_qr_images'));

app.use(express.json());
const PORT = 5000;

// Serve static files from the public directory

app.use(express.static(path.join(__dirname, 'public')));

// Serve QR images from /qr route
app.get('/qr', (req, res) => {
    const userId = req.query.userId;
    if (!userId) {
        return res.status(400).send('User ID is required.');
    }

    const qrPath = path.join(__dirname, 'qr', userId, 'qr.png');

    if (fs.existsSync(qrPath)) {
        res.setHeader('Content-Type', 'image/png');
        fs.createReadStream(qrPath).pipe(res);
    } else {
        res.status(404).send('QR code not found.');
    }
});

app.get('/proxy-qr', async (req, res) => {
  const userId = req.query.userId;
  const imageUrl = `http://localhost:5000/qr/?userId=${userId}`;

  const response = await fetch(imageUrl);
  const buffer = await response.arrayBuffer();

  res.set('Access-Control-Allow-Origin', '*');
res.set('Content-Type', 'image/png'); // or image/jpeg etc.

  res.send(Buffer.from(buffer));
});




// Route to trigger WhatsApp connection
app.get('/connect', (req, res) => {
    const userId = req.query.userId;

    if (!userId) {
        return res.status(400).send('User ID is required.');
    }

    const userFolderPath = path.join(__dirname, 'auth', userId);
    if (!fs.existsSync(userFolderPath)) {
        connectwhatsapp(userId)
            .then(() => {
                res.json({
                    message: 'WhatsApp connection started. Please scan the QR code.',
                    url: `http://localhost:${PORT}/qr/?userId=${userId}`
                });
            })
            .catch(err => {
                console.error("Error starting WhatsApp connection:", err);
                res.status(500).send('Failed to start WhatsApp connection.');
            });
    } else if (fs.readdirSync(userFolderPath).length === 0) {
        const userPath = path.join(__dirname, 'users.json');
        if (fs.existsSync(userPath)) {
            let users = JSON.parse(fs.readFileSync(userPath, 'utf-8'));
            // users is expected to be an array of objects
            const userIndex = users.findIndex(u => u.userId === userId);
            if (userIndex !== -1) {
            users[userIndex].timestamp = Date.now();
            fs.writeFileSync(userPath, JSON.stringify(users, null, 2));
            res.json({
                    message: 'WhatsApp connection started. Please scan the QR code.',
                    url: `http://localhost:${PORT}/qr/?userId=${userId}`
                });
            } else {
            res.status(404).send('User not found.');
            }
        }
    }
    else
    {
        res.json({ message: 'Already connected.' });
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
        res.json({ message: 'Please log in first by scanning the QR code.' });
    }
});

app.post('/getLinks', (req, res) => {
    const userId = req.query.userId;
    const date = req.body.date;
    if (!userId) {
        return res.status(400).send('User ID is required.');
    }

    if (!date) {
        return res.status(400).send('Date is required.');
    }

    const statsFolderPath = path.join(__dirname, 'countstats', userId);
    const filePath = path.join(statsFolderPath, `links.json`);

    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        getLinks(userId,date)
            .then(links => {
                res.json(links);
            })
            .catch(err => {
                console.error("Error fetching links:", err);
                res.status(500).send('Failed to fetch Links.');
            });
    } else {
        res.json({ message: 'Please share links to see analytics' });
    }
});


app.post('/getLinkstatus', (req, res) => {
    const userId = req.query.userId;
    const link = req.body.link;
    if (!userId) {
        return res.status(400).send('User ID is required.');
    }

    if (!link) {
        return res.status(400).send('Date is required.');
    }

    const statsFolderPath = path.join(__dirname, 'countstats', userId);
    const filePath = path.join(statsFolderPath, `links.json`);

    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        try {
            const status = getLinkStatus(userId, link);
            res.json(status);
        } catch (err) {
            console.error("Error checking link status:", err);
            res.status(500).send('Failed to check Link Status.');
        }
    } else {
        res.status(404).json({ message: 'Please make sure to login Whatsapp or Telegram' });
    }
});


app.post('/separateLinks', (req, res) => {
    const message = req.body.text;
    if (!message) {
        return res.status(400).send('message is required.');
    }
        try {
            const links = separator(message);
            res.json(links);
        } catch (err) {
            console.error("Error separatig links:", err);
            res.status(500).send('Failed to separate links.');
        }
});

app.post('/convertLink', (req, res) => {
    const link = req.body.link;
    const token= req.body.token;
    if (!link) {
        return res.status(400).send('Link is required.');
    }
    if (!token) {
        return res.status(400).send('Token is required.');
    }
        try {
            const link = sshortenUrlWithBitly(link, token);
            res.json({converted: link});
        } catch (err) {
            console.error("Error concerting link:", err);
            res.status(500).send('Failed to convert link.');
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
        res.json({ message: 'Please log in first by scanning the QR code.' });
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
    else {
        try {
            const url = incrementLinkClick(userId, linkId);
            return res.redirect(url);
        } catch (err) {
            console.error(err);
            return res.status(404).send(err.message);
        }
    }
});

app.get('/statscounts', async (req, res) => {
    const userId = req.query.userId;

    if (!userId) {
        return res.status(400).json({ error: 'User ID is required.' });
    }
    const userFolderPath = path.join(__dirname, 'countstats', userId);
    if (!fs.existsSync(userFolderPath) || fs.readdirSync(userFolderPath).length === 0) {
        return res.status(403).send('User is not logged in.');
    }
    try {
        const stats = await getStats(userId);
        return res.status(200).json(stats);

    } catch (err) {
        console.error("Error fetching stats:", err);
        return res.status(500).json({ error: 'Failed to fetch stats.' });
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

app.get('/status', (req, res) => {
    const userId = req.query.userId;

    if (!userId) {
        return res.status(400).send('User ID is required.');
    }

    const userFolderPath = path.join(__dirname, 'auth', userId);

    if (fs.existsSync(userFolderPath) && fs.readdirSync(userFolderPath).length > 0) {
        res.json({ status: 'True' });
    } else {
        res.json({ status: 'False' });
    }
});

// Start the server
app.listen(PORT, '0.0.0.0',() => {
    initializeWhatsAppStore(); // Initialize WhatsApp store
    console.log(`Server running at http://localhost:${PORT}`);

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
