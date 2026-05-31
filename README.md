# Veeam v13 Secure Gateway & AI Skill Integration

This repository contains a complete solution to securely integrate an AI Assistant (like Gemini) with a Veeam Backup & Replication v13 environment.

## Repository Structure

- **`gateway/`**: The secure proxy gateway deployed on the Atelier platform (or runnable locally with Docker/Podman). It manages credentials, token caching, global blocklist rules, Role-Based Access Control (RBAC), and logs audit events to an SQLite database. 
  - *See [gateway/README.md](gateway/README.md) for local container running instructions.*
- **`skills/veeam-v13/`**: The custom AI skill directory that equips the agent with instructions and a local schema search tool (`veeam_search.py` + `swagger.json`) to find and call Veeam endpoints securely.
  - *See [skills/veeam-v13/SKILL.md](skills/veeam-v13/SKILL.md) for agent usage guides.*

## Setup Instructions

See the README files in the respective directories for detailed configuration and deployment guides.
