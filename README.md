# Veeam v13 Secure Gateway & AI Skill Integration

This repository contains a complete solution to securely integrate an AI Assistant (like Gemini) with a Veeam Backup & Replication v13 environment.

## Repository Structure

- **`gateway/`**: The secure proxy gateway deployed on the Atelier platform. It manages credentials, token caching, global blocklist rules, Role-Based Access Control (RBAC), and logs audit events to an SQLite database.
- **`skills/veeam-v13/`**: The custom AI skill directory that equips the agent with instructions and a local schema search tool (`veeam_search.py` + `swagger.json`) to find and call Veeam endpoints securely.

## Setup Instructions

See the README files in the respective directories for detailed configuration and deployment guides.
