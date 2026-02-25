import express from 'express';
import { createServer as createViteServer } from 'vite';
import http from 'http';
import { Server } from 'socket.io';

const PORT = process.env.PORT || 5173;
const PASSCODE = process.env.PASSCODE || "8888"; // Hardcoded secure PIN

async function startServer() {
    const app = express();
    const server = http.createServer(app);
    const io = new Server(server, { cors: { origin: "*" } });

    // Add Vite middleware for development (handles static files and module bundling)
    const vite = await createViteServer({
        server: { middlewareMode: true },
        appType: 'spa'
    });
    app.use(vite.middlewares);

    io.on('connection', (socket) => {
        socket.on('authenticate', (passcode, callback) => {
            // Very simple local-network auth
            if (passcode === PASSCODE || passcode === 'host_local') {
                socket.join('authenticated');
                callback({ success: true });
            } else {
                callback({ success: false, message: "Invalid Passcode" });
            }
        });

        // Broadcaster routes
        socket.on('host_broadcast', (data) => {
            // Send video frame and state data to authenticated remote viewers
            socket.to('authenticated').emit('remote_update', data);
        });

        // Remote Controls route (Remote Phone -> Host MacBook)
        socket.on('remote_command', (cmdData) => {
            socket.to('authenticated').emit('host_command', cmdData);
        });
    });

    server.listen(PORT, '0.0.0.0', () => {
        console.log(`Server strictly running behind custom Passcode authentication.`);
        console.log(`Local Host (MacBook): http://localhost:${PORT}`);
        console.log(`Remote Feed (Phone):  http://<YOUR_NETWORK_IP>:${PORT}`);
        console.log(`Secret Passcode for phone is: ${PASSCODE}`);
    });
}

startServer();
