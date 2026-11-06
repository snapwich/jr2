Feature: An Instance declares its MCP servers, and jr2 refuses a name or a list it cannot keep
  ADR-0079. The `mcp` block of `jr2.config.ts` declares each MCP server by a name of the author's.
  An Agent names the servers and the tools it uses, and an `mcp` Effect names a server and a tool.
  `jr2 up` refuses what it cannot keep before it converges anything, and prints the line to add.
  `jr2 check` runs the same check with no cluster (ADR-0050), so each refusal here is `jr2 up`'s.
  The publish door runs the walk of the Agents' lists too (ADR-0069).

  The live check of each allowlisted tool name runs from the check pod, through its Custodian
  (ADR-0019). No host-booted fixture has a check pod, so the @kind tier holds that claim.

  Rule: an Agent names only servers the config declares, with an allowlist for a remote server

    Scenario: an Agent that names a server the config does not declare is refused, with the entry to add
      Given a fresh instance
      And the instance's mcp block declares no server
      And a workflow "clerk" whose Menu-only Agent has the MCP list [{ server: "notes", tools: ["search"] }]
      When I check the instance
      Then the check refuses it with the line naming:
        | workflow "clerk": Agent "clerk" names the MCP server "notes" |
        | mcp: { "notes": { url: "https://<host>/mcp", secret: "<SECRET>" } } |

    Scenario: a remote server with no allowlist is refused
      Given a fresh instance
      And the instance's mcp block declares:
        """
        notes: { url: "https://mcp.notes.test/mcp", secret: "NOTES_TOKEN" },
        """
      And a workflow "clerk" whose Menu-only Agent has the MCP list [{ server: "notes" }]
      When I check the instance
      Then the check refuses it with the line naming:
        | names the remote MCP server "notes" with no tools |
        | tools: "*" for every tool |

    Scenario: a Menu-only Agent that names a stdio server is refused
      ADR-0031. A stdio server runs as Workspace code, inside a Sandbox's confinement, and the
      Instance Harness, where a Menu-only Agent's Turns run, has none.
      Given a fresh instance
      And the instance's mcp block declares:
        """
        notes: { command: "notes-mcp" },
        """
      And a workflow "clerk" whose Menu-only Agent has the MCP list [{ server: "notes" }]
      When I check the instance
      Then the check refuses it with the line naming:
        | has workspace: "none" and names the stdio MCP server "notes" |

    Scenario: an Agent with an allowlist on a declared remote server passes the check
      Given a fresh instance
      And the instance's mcp block declares:
        """
        notes: { url: "https://mcp.notes.test/mcp", secret: "NOTES_TOKEN" },
        """
      And a workflow "clerk" whose Menu-only Agent has the MCP list [{ server: "notes", tools: ["search"] }]
      When I check the instance
      Then the check passes

    Scenario: a tools list on a server whose secret the workspace() grants is refused, with the line to write
      ADR-0028. The workspace() grants the server's secret, so Workspace code in the Sandbox can
      spend it on any tool of the server, and jr2 cannot keep a list. Only "*" says what is true.
      Given a fresh instance
      And the instance's mcp block declares:
        """
        notes: { url: "https://mcp.notes.test/mcp", secret: "NOTES_TOKEN" },
        """
      And a workflow "granted" whose Sandbox Agent has the MCP list [{ server: "notes", tools: ["search"] }], in a workspace() that grants "NOTES_TOKEN"
      When I check the instance
      Then the check refuses it with the line naming:
        | gives a tools list for MCP server "notes" |
        | NOTES_TOKEN: its workspace() lists it under secrets |
        | write { server: "notes", tools: "*" } |

  Rule: the config refuses a server name or a url that cannot carry its secret

    Scenario: the name jr2 is reserved for the Menu
      Given a fresh instance
      And the instance's mcp block declares:
        """
        jr2: { url: "https://mcp.notes.test/mcp" },
        """
      When I check the instance
      Then the check refuses it with the line naming:
        | at mcp.jr2: the server name jr2 is reserved |

    Scenario: a server with a secret at an http:// url is refused
      ADR-0059. The Custodian puts a value on TLS only.
      Given a fresh instance
      And the instance's mcp block declares:
        """
        notes: { url: "http://mcp.notes.test/mcp", secret: "NOTES_TOKEN" },
        """
      And a workflow "clerk" whose Menu-only Agent has the MCP list [{ server: "notes", tools: ["search"] }]
      When I check the instance
      Then the check refuses it with the line naming:
        | mcp.notes.url must be an https:// URL |

  Rule: an mcp Effect calls a remote server the config declares

    Scenario: an mcp Effect that names an undeclared server is refused, with the entry to add
      Given a fresh instance
      And the instance's mcp block declares no server
      And a workflow "search" whose mcp Effect calls the tool "search" of the server "notes"
      When I check the instance
      Then the check refuses it with the line naming:
        | workflow "search": the mcp Effect "search" names the MCP server "notes" |
        | mcp: { "notes": { url: "https://<host>/mcp", secret: "<SECRET>" } } |

    Scenario: an mcp Effect that names a stdio server is refused
      ADR-0079. An `mcp` Effect runs in the Instance Effector, which starts no program.
      Given a fresh instance
      And the instance's mcp block declares:
        """
        notes: { command: "notes-mcp" },
        """
      And a workflow "search" whose mcp Effect calls the tool "search" of the server "notes"
      When I check the instance
      Then the check refuses it with the line naming:
        | the mcp Effect "search" names the stdio MCP server "notes" |

    Scenario: an mcp Effect on a declared remote server passes the check
      Given a fresh instance
      And the instance's mcp block declares:
        """
        notes: { url: "https://mcp.notes.test/mcp", secret: "NOTES_TOKEN" },
        """
      And a workflow "search" whose mcp Effect calls the tool "search" of the server "notes"
      When I check the instance
      Then the check passes

  Rule: the publish door refuses an Agent that names an undeclared server, and the old Assembly keeps serving

    Scenario: a publish that skipped jr2 up is refused at the door
      Given a fresh instance
      And the instance's mcp block declares no server
      And the orchestrator is serving
      And a workflow "clerk" whose Menu-only Agent has the MCP list [{ server: "notes", tools: ["search"] }]
      When I publish the Assembly and the door refuses it
      Then the door's refusal names the MCP server "notes" of the workflow "clerk"
      And the Orchestrator still serves the Assembly it served before the refusal
