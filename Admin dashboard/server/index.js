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
const Package = require('./models/Package');
const Addon = require('./models/Addon');

// Auth middleware (placeholder, implement JWT in real app)
const auth = (req, res, next) => { next(); };

// ============================================================
// APPS
// ============================================================

app.get('/api/apps', auth, async (req, res) => {
  const apps = await AppModel.find().sort({ company: 1, name: 1 });
  res.json(apps);
});

app.post('/api/apps', auth, async (req, res) => {
  const { name, company, apiEndpoint } = req.body;
  if (!name || !company) return res.status(400).json({ error: 'name and company are required' });
  const newApp = await AppModel.create({ name, company, apiEndpoint });
  res.status(201).json(newApp);
});

app.put('/api/apps/:id', auth, async (req, res) => {
  const { name, company, apiEndpoint } = req.body;
  const updated = await AppModel.findByIdAndUpdate(
    req.params.id,
    { name, company, apiEndpoint },
    { new: true }
  );
  if (!updated) return res.status(404).json({ error: 'App not found' });
  res.json(updated);
});

app.delete('/api/apps/:id', auth, async (req, res) => {
  await AppModel.findByIdAndDelete(req.params.id);
  // Cascade delete packages and addons for this app
  await Package.deleteMany({ app: req.params.id });
  await Addon.deleteMany({ app: req.params.id });
  res.json({ success: true });
});

// ============================================================
// PACKAGES
// ============================================================

app.get('/api/apps/:id/packages', auth, async (req, res) => {
  const packages = await Package.find({ app: req.params.id }).sort({ price: 1 });
  res.json(packages);
});

app.post('/api/apps/:id/packages', auth, async (req, res) => {
  const { name, price, billingCycle, maxEmployees, features, isActive } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const pkg = await Package.create({
    app: req.params.id,
    name,
    price: price || 0,
    billingCycle: billingCycle || 'monthly',
    maxEmployees: maxEmployees || 0,
    features: features || [],
    isActive: isActive !== undefined ? isActive : true
  });
  res.status(201).json(pkg);
});

app.put('/api/packages/:id', auth, async (req, res) => {
  const { name, price, billingCycle, maxEmployees, features, isActive } = req.body;
  const pkg = await Package.findByIdAndUpdate(
    req.params.id,
    { name, price, billingCycle, maxEmployees, features, isActive },
    { new: true }
  );
  if (!pkg) return res.status(404).json({ error: 'Package not found' });
  res.json(pkg);
});

app.delete('/api/packages/:id', auth, async (req, res) => {
  await Package.findByIdAndDelete(req.params.id);
  res.json({ success: true });
});

// ============================================================
// ADD-ONS
// ============================================================

app.get('/api/apps/:id/addons', auth, async (req, res) => {
  const addons = await Addon.find({ app: req.params.id }).sort({ price: 1 });
  res.json(addons);
});

app.post('/api/apps/:id/addons', auth, async (req, res) => {
  const { name, price, billingCycle, description, isActive } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const addon = await Addon.create({
    app: req.params.id,
    name,
    price: price || 0,
    billingCycle: billingCycle || 'monthly',
    description: description || '',
    isActive: isActive !== undefined ? isActive : true
  });
  res.status(201).json(addon);
});

app.put('/api/addons/:id', auth, async (req, res) => {
  const { name, price, billingCycle, description, isActive } = req.body;
  const addon = await Addon.findByIdAndUpdate(
    req.params.id,
    { name, price, billingCycle, description, isActive },
    { new: true }
  );
  if (!addon) return res.status(404).json({ error: 'Addon not found' });
  res.json(addon);
});

app.delete('/api/addons/:id', auth, async (req, res) => {
  await Addon.findByIdAndDelete(req.params.id);
  res.json({ success: true });
});

// ============================================================
// USERS / SUBSCRIPTIONS (existing)
// ============================================================

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

