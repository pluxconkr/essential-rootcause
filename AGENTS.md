# Expo HAS CHANGED
Read the exact versioned docs at https://docs.expo.dev/versions/v57.0.0/ before writing any code.
Sibling projects with the same stack and design system: ../nmi-typhoon-watch (read its src/ui and src/data first), ../studyspace.
Spec: ../docs/3_NewJersey_2.HTM. Plan: .omc/plans/rootcause-v1-production-plan.md.
Rules: src/domain has no RN/Expo imports. src/server is imported only from src/app/api. Secrets never reach the client.
No in-memory state in routes (workerd). Every public response goes through toPublicReport(). Every write route requires a session.
Every number on screen is explainable (see /why). Demo data is labelled. No spinners. Offline is not an error.
Before touching src/server/vision.ts load the claude-api skill. Map provider details live in src/ui/HazardMap*.tsx only.
