# Rel.AI Skill Provenance

All six built-in skills in this package are first-party Rel.AI content maintained in this repository and versioned with the plugin.

The built-in set is intentionally limited to Rel.AI development methodology: work-session orchestration, architecture-aware planning, evidence-based investigation, causal debugging, risk-based verification, and persistent-process lifecycle management. Framework, language, product-domain, and other optional expertise stays outside this built-in catalog. The desktop application has no skill-management UI or library manager. Separately, the Rel.AI runtime can discover skills placed in project-level or user-level `.agents/skills` directories; those discovered skills do not become part of this built-in package.

The modular architecture was informed by general progressive-disclosure and single-responsibility patterns used by agent workflow projects, including `obra/superpowers` revision `44c9b2d6e889982ac18c27d05a19fefe335194e1`. No third-party skill text was copied or vendored into the built-in Rel.AI skill set.
