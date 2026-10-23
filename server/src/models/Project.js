import mongoose from 'mongoose';

/**
 * A Scenetics project. The whole scene (the editor's single source of
 * truth) is stored as ONE native MongoDB document — scene JSON maps
 * naturally onto a document, which is why MongoDB was chosen.
 */
const projectSchema = new mongoose.Schema(
  {
    // Set from the authenticated user once Google OAuth is fully wired.
    // TODO(auth): populate from session/JWT in the auth middleware instead
    // of trusting the request body.
    ownerId: { type: String, default: 'anonymous', index: true },
    name: { type: String, required: true, default: 'Untitled' },
    scene: { type: mongoose.Schema.Types.Mixed, required: true },
  },
  { timestamps: true }
);

export const Project = mongoose.models.Project || mongoose.model('Project', projectSchema);
