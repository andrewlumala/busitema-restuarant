const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret';

// Wires up real-time rooms:
//   - 'kitchen'          → all kitchen/admin staff join this room, receive every new order
//   - 'student:<id>'     → each student joins their own room, receives only their order updates
function initSockets(io) {
  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      socket.user = jwt.verify(token, JWT_SECRET);
      next();
    } catch {
      next(new Error('Unauthorized socket connection'));
    }
  });

  io.on('connection', (socket) => {
    const { role, student_id } = socket.user;

    if (role === 'kitchen' || role === 'cashier' || role === 'admin') {
      socket.join('kitchen');
    }
    if (role === 'student') {
      socket.join(`student:${student_id}`);
    }

    socket.on('disconnect', () => {
      // Socket.IO handles room cleanup automatically on disconnect
    });
  });
}

module.exports = initSockets;
