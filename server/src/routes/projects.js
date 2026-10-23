import { Router } from 'express';
import mongoose from 'mongoose';
import { Project } from '../models/Project.js';

export const projectsRouter = Router();

// The server must run (and answer /api/health) even with no MongoDB.
// Project routes therefore check the connection and fail cleanly.
function requireDb(_req, res, next) {
  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({ error: 'Database not connected. Set MONGODB_URI and restart the server.' });
  }
  next();
}

projectsRouter.use(requireDb);

// TODO(auth): add an auth middleware here that sets req.ownerId from the
// Google session, and filter all queries by it. Structure is ready for it.

// Create
projectsRouter.post('/', async (req, res) => {
  try {
    const { name, scene, ownerId } = req.body || {};
    if (!scene || typeof scene !== 'object') {
      return res.status(400).json({ error: 'Body must include a scene object.' });
    }
    const project = await Project.create({ name: name || 'Untitled', scene, ownerId: ownerId || 'anonymous' });
    res.status(201).json(project);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List
projectsRouter.get('/', async (req, res) => {
  try {
    const filter = req.query.ownerId ? { ownerId: req.query.ownerId } : {};
    const projects = await Project.find(filter).sort({ updatedAt: -1 }).limit(100);
    res.json(projects);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Read one
projectsRouter.get('/:id', async (req, res) => {
  try {
    const project = await Project.findById(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found.' });
    res.json(project);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update
projectsRouter.put('/:id', async (req, res) => {
  try {
    const { name, scene } = req.body || {};
    const patch = {};
    if (name !== undefined) patch.name = name;
    if (scene !== undefined) patch.scene = scene;
    const project = await Project.findByIdAndUpdate(req.params.id, patch, { new: true });
    if (!project) return res.status(404).json({ error: 'Project not found.' });
    res.json(project);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete (bonus, completes CRUD)
projectsRouter.delete('/:id', async (req, res) => {
  try {
    const project = await Project.findByIdAndDelete(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found.' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
