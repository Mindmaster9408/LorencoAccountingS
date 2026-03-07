require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

// Connect to MongoDB
mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/admin-dashboard', {
  useNewUrlParser: true,
  useUnifiedTopology: true
});

// Models
const User = require('./models/User');
const AppModel = require('./models/App');
const Subscription = require('./models/Subscription');

// Auth middleware (placeholder, implement JWT in real app)
const auth = (req, res, next) => { next(); };

// Routes
app.get('/api/users', auth, async (req, res) => {
  const users = await User.find().populate({
    path: 'subscriptions',
    populate: { path: 'app' }
  });
  res.json(users);
});

app.post('/api/subscription/:id/activate', auth, async (req, res) => {
  const sub = await Subscription.findByIdAndUpdate(req.params.id, { active: true }, { new: true });
  res.json(sub);
});

app.post('/api/subscription/:id/inactivate', auth, async (req, res) => {
  const sub = await Subscription.findByIdAndUpdate(req.params.id, { active: false }, { new: true });
  res.json(sub);
});

app.post('/api/subscription/:id/remind', auth, async (req, res) => {
  // TODO: Send reminder (email, webhook, etc.)
  // Optionally trigger reminder in other company via API/webhook
  res.json({ success: true, message: 'Reminder sent (placeholder)' });
});

app.put('/api/subscription/:id/employee-count', auth, async (req, res) => {
  const { count } = req.body;
  if (typeof count !== 'number' || count < 0) {
    return res.status(400).json({ error: 'Invalid employee count' });
  }
  const sub = await Subscription.findByIdAndUpdate(req.params.id, { employeeCount: count }, { new: true });
  res.json(sub);
});

app.listen(4000, () => console.log('Server running on port 4000'));
