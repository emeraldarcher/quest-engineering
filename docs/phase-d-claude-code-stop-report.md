# Phase D Claude Code stop report

**Stop boundary:** Phase D only. Phase E has not begun.

1. Canonical production harness identity is `claude_code`.
2. `ClaudeCodeHarness` implements the provider-neutral `AgentHarness` contract.
3. `claude_agent_sdk` remains present as an explicit deprecated fallback.
4. No automatic fallback from `claude_code` exists.
5. Claude Code is pinned to `2.1.292`.
6. The package source is pinned to `@anthropic-ai/claude-agent-sdk` `0.3.292`.
7. Linux arm64 runtime SHA-256 is pinned and verified.
8. Linux x64 runtime SHA-256 is pinned and verified.
9. The production model is exactly `anthropic/claude-opus-4-6`.
10. The production effort is exactly `high`.
11. Model fallback is disabled.
12. Fast mode is disabled.
13. The account profile is `qe-claude-account-v1`.
14. The Run profile is `qe-claude-broker-run-v1`.
15. The account profile is ProviderAccount-owned and persistent.
16. The Run profile is Run-owned and credential-free.
17. The account and Run profiles have distinct immutable identities.
18. The Run profile has deny-all network policy.
19. The Run profile contains no Claude runtime.
20. The Run profile contains no managed Claude settings.
21. The Run profile contains no managed Claude Mod.
22. The account profile contains no Run workspace authority.
23. Account runtime files are root-owned.
24. Account runtime files are non-writable by the Claude user.
25. Managed settings are root-owned mode `0444`.
26. Managed Mod source is root-owned mode `0444`.
27. The fixed bridge is root-owned executable-only runtime code.
28. Exact bridge SHA-256 is startup-verified.
29. Exact managed settings SHA-256 is startup-verified.
30. Exact managed Mod SHA-256 is startup-verified.
31. Exact Claude binary SHA-256 is startup-verified.
32. Profile assets are repository-hashed before provisioning.
33. The organization marketplace path is immutable.
34. The QE Mod is loaded through managed settings, not `--plugin-dir`.
35. Production launch contains no `--plugin-dir`.
36. The built-in `cc-plugin-sec-default` guard is retained.
37. `allowManagedModsOnly` is enabled.
38. User hooks are excluded by managed policy.
39. Sideload flags are disabled.
40. MCP servers are managed-only with an empty allowlist.
41. Claude.ai connectors are disabled.
42. Claude.ai plugin synchronization is disabled.
43. Claude.ai skill synchronization is disabled.
44. Bundled skills are disabled.
45. Native subagents are disabled.
46. Agent view is disabled.
47. Remote Control is disabled.
48. Artifact support is disabled.
49. Git instructions are disabled.
50. Bypass-permission mode is disabled.
51. Permission mode is exactly `dontAsk`.
52. Permission prompts are disabled.
53. The native tool inventory is restricted with exact `--tools`.
54. `--allowedTools` is not used as an availability control.
55. The only exposed tools are eight QE managed-Mod tools.
56. Workspace read maps to `filesystem.read`.
57. Workspace list maps to `filesystem.list`.
58. Workspace write maps to `filesystem.write`.
59. Workspace edit maps to `filesystem.edit`.
60. Workspace search maps to `search.grep`.
61. Run shell maps to `terminal.shell`.
62. Completion maps separately to `HarnessControlAuthority`.
63. HumanAttention maps separately to `HarnessControlAuthority`.
64. The Mod denies unapproved tool calls.
65. The Mod denies subagent tool calls.
66. The Mod denies subagent offers and spawns.
67. The Mod denies local slash-command execution.
68. The Mod fails closed on prompt middleware errors.
69. The Mod fails closed on tool middleware errors.
70. The Mod enforces exact model and effort on every turn step.
71. Post-hoc server-tool observation is defense in depth only.
72. Preventive server-tool proof inspects outbound request construction.
73. Fresh request bodies omit all known provider/server tools.
74. Multi-turn request bodies omit all known provider/server tools.
75. Retry request bodies omit all known provider/server tools.
76. High-context compaction-path request bodies omit all known provider/server tools.
77. Exact-resume/recovery request bodies omit all known provider/server tools.
78. Advisor beta/tool identifiers are absent.
79. Web-search beta/tool identifiers are absent.
80. Agent-toolset beta/tool identifiers are absent.
81. Native Bash/Read/Write/Edit/Task/Agent definitions are absent.
82. Fake-boundary tests make zero external provider requests.
83. Startup sends one synthetic `shouldQuery: false` message.
84. Startup performs zero model inference.
85. Startup requires exact `system/init` version provenance.
86. Startup requires `apiKeySource: "oauth"`.
87. Authentication validation requires `authMethod: "claude.ai"`.
88. Startup requires the exact native session UUID.
89. Startup requires the account-cell cwd.
90. Startup requires exact model and effort.
91. Startup requires exact permission mode.
92. Startup requires the exact QE and built-in guard plugin inventory.
93. Startup rejects plugin load errors.
94. Startup rejects any MCP server.
95. Startup rejects any skill.
96. Startup rejects any agent.
97. Startup requires exactly the eight QE tools.
98. Assistant frames are checked for exact model provenance.
99. Result model-usage keys are checked for exact model provenance.
100. Product selects exactly one authenticated Anthropic account.
101. Zero matching accounts fail closed.
102. Multiple matching accounts fail closed.
103. Dispatch durably stores account ID and credential generation.
104. Dispatch durably stores broker authorization, session, and generation.
105. Broker authority is complete-or-empty by database constraint.
106. Broker authorization identity is unique.
107. Dispatch acknowledgment no longer waits for Run-context existence.
108. Worker broker preparation waits boundedly for post-ack Run creation.
109. Prompt authorization requires admitted exact broker authority.
110. ProviderAccount operations are serialized, and native sessions are durably bound to account/environment/model/effort/lineage.
111. Lost attached streams after prompt intent are never replayed or inferred.
112. Physical two-cell SBX proof passed with canaries, trap rejection, and cleanup.
113. Default Worker tests, TypeScript, Elixir compile, and the full server test suite passed.
114. Work stops here: no real login, credentials, paid turn, production action, merge, or Phase E work was performed.
