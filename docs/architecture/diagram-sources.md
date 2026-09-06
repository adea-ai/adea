# Agent HQ Diagram Sources

Status: Canonical repository source
Owner: Agent HQ architecture
Last reviewed: 2026-08-28

These Mermaid definitions are the version-controlled Agent HQ source for the rendered diagrams cataloged in the canonical Google Docs. Cross-repository Control Plane and Cortana diagrams remain in their owning repositories.

## Editing and rendering rules

1. Edit the owning Mermaid definition first.
2. Render and inspect the diagram before replacing the image in its owning Google Doc.
3. Keep headings aligned with the owning document and figure purpose.
4. Do not hand-edit rendered diagram images.
5. Physical provider resource names such as R2 bucket names, Wrangler bindings, Neon project IDs, and Railway project IDs are deployment configuration, not domain identifiers.
6. Agent HQ and Control Plane may share a Cloudflare account/provider, but they use separate bucket/credential authority. The Control Plane `ctrl-plane` bucket is not Agent HQ Artifact storage.

## Agent HQ PRD: Product Architecture

```mermaid
flowchart TB
    U([User]) --> HQ[Agent HQ Workspace]
    HQ --> CP[Control Plane]
    CP --> CPO{Optional ContextProvider?}
    CPO -->|No / disabled| EP[Immutable ExecutionPlan]
    CPO -->|Yes| CXT[Validated ContextContribution]
    CXT --> EP
    EP --> TW[Restate]
    TW --> D{Graph semantics required?}
    D -->|No| RA[Runtime Adapter]
    D -->|Yes| LG[LangGraph.js]
    LG --> RA
    RA --> PI[Managed Pi]
    RA --> ACP[ACP Adapter]
    ACP --> EXT[External Harnesses]
    PI --> MT[Models & Tools]
    EXT --> MT
```

## System Architecture Overview

```mermaid
flowchart TB
    subgraph HQ["Agent HQ — Private First-Party Product"]
        C[Desktop / Web / Mobile UI]
        API[Application Services]
        HQDB[(Agent HQ Neon / Cloud-Safe Metadata)]
        RELAY[Agent HQ Remote Relay / HPKE Ciphertext]
        EVT[Railway Event Gateway / Neon WorkspaceEvents]
    end
    subgraph CP["Control Plane — Open Source / Apache-2.0"]
        CPAPI[Control API / Public SDK]
        POL[Profiles / Skills / ProjectState / Context Policy]
        CPO{Optional ContextProvider?}
        PLAN[Immutable ExecutionPlan]
        TW[Restate Durable Lifecycle]
        LG[LangGraph.js Bounded Graph Segments]
        RA[Runtime Adapters]
        TG[Tool Gateway / Shared Integrations / MCP]
        MG[Model Gateway]
        SB[SandboxProvider]
        CPDB[(PersistenceProvider: SQLite Local/Simple / PostgreSQL Server/Cloud)]
    end
    subgraph CT["Optional Context / Memory Providers"]
        CTAPI[Cortana — Preferred / Desktop / MCP / HTTP / CLI]
        CB[Bounded ContextBundle]
        CTDB[(Cortana Local SQLite Brain)]
        ALT[Other Compatible Provider]
        ALTDB[(Alternate Provider-Owned Store)]
    end
    subgraph RuntimeInfra["Runtime Infrastructure and Concrete Runtimes"]
        RG[Runtime Gateway - non-co-located RuntimeNode only]
        DR[RuntimeDrivers]
        PI[Managed Pi]
        EXT[ACP External Harnesses]
    end
    C --> API
    API <--> HQDB
    API --> EVT
    EVT --> C
    API -->|Local/direct or ordinary service API| CPAPI
    API -->|Remote web/mobile command| RELAY
    RELAY -->|Metadata + HPKE ciphertext| CPAPI
    API -->|Optional first-party configuration and browsing| CTAPI
    CPAPI --> POL
    POL --> CPO
    POL <--> CPDB
    PLAN <--> CPDB
    CPO -->|None / disabled| PLAN
    CPO -->|Cortana| CTAPI
    CPO -->|Alternate| ALT
    PLAN --> TW
    TW --> RA
    TW --> LG
    LG --> RA
    RA --> TG
    RA --> MG
    RA --> SB
    RA --> DR
    RA -->|Remote RuntimeNode only| RG
    CTAPI <--> CTDB
    CTAPI --> CB
    ALT <--> ALTDB
    ALT --> ACB[Bounded Alternate Provider Response]
    CB -. Validated ContextContribution .-> PLAN
    ACB -. Validated ContextContribution .-> PLAN
    RG --> DR
    DR --> PI
    DR --> EXT
    NOTE[No direct cross-database reads, shared credentials, or private-code dependency]
    HQDB -. isolated .-> NOTE
    CPDB -. isolated .-> NOTE
    CTDB -. isolated .-> NOTE
    ALTDB -. isolated .-> NOTE
    NONE[No provider is a supported baseline] -. no dependency .-> PLAN
```

## Agent HQ TDD: Application Architecture

```mermaid
flowchart TB
    U([User]) --> CL[Agent HQ Desktop Client]
    subgraph Client["Client Layer"]
        CL --> S[Agent Sim engine remote (entitlement-gated)]
        CL --> L[Channel / List View]
        CL --> UI[Task, Chat, Kanban, Settings]
        CL --> EC[Event Client]
    end
    subgraph App["Agent HQ Application Services"]
        AUTH["Neon Auth<br/>via @agent-hq/auth"]
        API[API]
        WS[Workspace / Agent / Task / Conversation Metadata Services]
        RELAY[Remote Control Relay / HPKE]
        EV[Railway Event Gateway]
        DB[(Neon / Drizzle Cloud Metadata)]
    end
    CL --> AUTH
    CL <--> LC[(Encrypted Local Content / rusqlite)]
    AUTH --> API
    API --> WS
    WS --> DB
    CL -->|Local direct| CP[Local Control Plane]
    API --> RELAY
    RELAY -->|Remote metadata + HPKE ciphertext| CP
    CP --> API
    WS --> EV
    EV --> EC
```

## Agent HQ TDD: Remote-Origin Product Event Flow

```mermaid
sequenceDiagram
    actor U as User
    participant C as Agent HQ Client Surface
    participant A as Agent HQ API
    participant X as Agent HQ Remote Relay
    participant P as Selected Control Plane Host
    participant T as Restate
    participant RA as Runtime Adapter
    participant G as DirectLocalRuntimeTransport or Runtime Gateway
    participant R as Runtime
    participant E as Railway Event Gateway
    participant D as Event Store
    U->>C: User action
    C->>A: Remote semantic command / encrypted content
    A->>X: Route metadata + HPKE envelope
    X->>P: Deliver without plaintext access
    P->>P: Decrypt/validate content at selected host
    P->>T: Start durable workflow
    T->>RA: Invoke approved runtime activity
    RA->>G: Dispatch normalized runtime command
    G->>R: Execute through selected runtime path
    R-->>G: Progress / result
    G-->>RA: Correlated runtime messages
    RA-->>P: Normalized runtime events / result
    P-->>A: Normalized execution event
    A->>D: Transaction: update product state + append WorkspaceEvent
    D-->>E: Committed event available
    E-->>C: SSE WorkspaceEvent
    C->>C: Update/invalidate TanStack Query cache idempotently
    Note over C,D: Reconnect uses replay cursor to recover missed events
```

## Security & Trust Model: Trust Boundaries

```mermaid
flowchart LR
    U([User]) --> B[Browser / Agent HQ Client]
    subgraph AppCloud["Agent HQ Application Trust Zone"]
        AUTH["Neon Auth<br/>via @agent-hq/auth"]
        API[Agent HQ API]
        DB[(Agent HQ Neon / Cloud-Safe Metadata)]
        RELAY[Remote Relay / HPKE Ciphertext]
        EG[Railway Event Gateway]
        ART[@agent-hq/artifacts]
        BLOB[(Agent HQ Cloudflare R2 - separate product bucket)]
    end
    subgraph Control["Selected Control Plane Trust Zone - local, self-hosted, or managed cloud"]
        CP[Control Plane]
        CDB[(Control Plane SQLite local / PostgreSQL server)]
        SEC[(OS Secure Storage / Managed Secrets / Credential Leases)]
        RG[Runtime Gateway - non-co-located RuntimeNode only]
        TG[Tool Gateway / PolicyDecisionPoint]
        CG[ContextProvider Registry / Policy / Adapters]
        MG[Model Gateway]
        SB[SandboxProvider]
    end
    subgraph Local["User Device Trust Zone"]
        LC[(Encrypted Agent HQ Local Content)]
        RH[Desktop Local Runtime Host]
        MP[Managed Local Pi]
        EH[External Harnesses]
        CT[Cortana / Local Context Provider]
    end
    subgraph External["External Provider / Connector Trust Zone"]
        PR[Models / Tools / Connectors / Sandbox Provider]
        XP[Remote Context / Memory Provider]
    end
    B --> AUTH
    AUTH --> API
    API --> DB
    API --> EG
    EG --> B
    API --> ART
    ART --> BLOB
    API -->|Cloud-safe service calls| CP
    API --> RELAY
    RELAY -->|Remote product command / HPKE| CP
    CP --> CDB
    CP --> SEC
    CP -->|Non-co-located RuntimeNode only| RG
    CP --> TG
    CP --> CG
    CP --> MG
    CP --> SB
    RG <-->|Outbound authenticated runtime channel| RH
    RH --> MP
    RH --> EH
    RH --> CT
    MP --> PR
    EH --> PR
    TG --> PR
    MG --> PR
    SB --> PR
    CG -->|Non-co-located provider request| XP
    CG -->|Co-located provider request| RH
```

## Data Model & API: Domain Relationships

```mermaid
erDiagram
    USER ||--o{ MEMBERSHIP : has
    WORKSPACE ||--o{ MEMBERSHIP : contains
    WORKSPACE ||--o{ ROOM : contains
    WORKSPACE ||--o{ AGENT : contains
    WORKSPACE ||--o{ TASK : contains
    WORKSPACE ||--o{ CONTENT_REF : owns
    WORKSPACE ||--o{ CHANNEL : contains
    CHANNEL ||--o{ MESSAGE : contains
    TASK ||--o| CONTENT_REF : private_content
    MESSAGE ||--o| CONTENT_REF : private_body
    AGENT ||--o{ TASK : assigned
    TASK ||--o{ EXECUTION_REF : references
    AGENT }o--|| AGENT_PROFILE_REF : uses
    WORKSPACE ||--o{ WORKSPACE_EVENT : emits
    WORKSPACE ||--o{ RUNTIME_CONNECTION_VIEW : surfaces
    RUNTIME_CONNECTION_VIEW ||--o{ EXTERNAL_SESSION_VIEW : exposes
    WORKSPACE ||--o{ CONTEXT_PROVIDER_VIEW : configures
    CONTEXT_PROVIDER_VIEW ||--o{ MEMORY_WRITE_PROPOSAL_VIEW : surfaces
```

## Data Model & API: Task and Execution State Machines

```mermaid
stateDiagram-v2
    state "Agent HQ Task" as Task {
        [*] --> Created
        Created --> Queued
        Queued --> Running
        Running --> AwaitingInput
        AwaitingInput --> Running
        Running --> Succeeded
        Running --> Failed
        Running --> Cancelled
    }
    state "Control Plane Execution" as Execution {
        [*] --> ECreated
        ECreated --> EQueued
        EQueued --> ERunning
        ERunning --> EAwaitingInput
        EAwaitingInput --> ERunning
        ERunning --> ESucceeded
        ERunning --> EFailed
        ERunning --> ECancelled
        ERunning --> ETimedOut
    }
```

## Nifty League Partnership: Product Boundary

```mermaid
flowchart LR
    subgraph HQ["Agent HQ"]
        W[Private Home / Office]
        P[Productivity / Agentic Tooling]
    end
    T[Exit Gate / Transition]
    subgraph NW["Nifty World"]
        S[Online Social World]
        G[Games / Activities]
    end
    W --> T --> S
    S --> T --> W
    P -. remains in Agent HQ .- W
    S --> G
```

## Nifty League Partnership: Cross-Product Handoff

```mermaid
sequenceDiagram
    actor U as User
    participant H as Agent HQ
    participant I as Integration Service
    participant N as Nifty World
    U->>H: Exit through gate
    H->>I: Request signed handoff
    I-->>H: Short-lived identity/session token + return route
    H->>N: Navigate with handoff
    N->>I: Validate token
    I-->>N: Minimum identity + avatar mapping
    N-->>U: Enter Nifty World
    U->>N: Return to Agent HQ
    N->>H: Navigate to signed return route
    Note over H,N: Productivity context, conversations, tasks, and credentials are not transferred
```

## MVP Local-First and Self-Hosted Runtime Topology

```mermaid
flowchart TB
    subgraph Clients["Agent HQ Clients"]
        D[Desktop App / Full Workspace]
        W[Web Remote Control]
        M[Mobile Remote Control]
    end
    subgraph Cloud["Agent HQ Cloud Coordination"]
        APP[Application Services]
        DB[(Neon / Drizzle Cloud Metadata)]
        RELAY[Durable Remote Relay / Metadata + HPKE Ciphertext]
        META[(Workspace / Device / Task Status Metadata)]
        EVT[Sync / Events]
    end
    subgraph RuntimeTransportInfra["Control Plane Runtime Transport"]
        RG[Runtime Gateway - non-co-located RuntimeNode only]
    end
    subgraph Local["Paired Developer Device"]
        LC[(Encrypted Agent HQ Local Content / rusqlite)]
        LCP[Local All-in-One Control Plane / Restate / node:sqlite]
        LG[Bounded LangGraph.js]
        RH[Local Runtime Host]
        MPI[Managed Local Pi]
        MPD[ManagedPiDriver]
        ACPD[ACPDriver]
        CPD[ContextProviderDriver]
        EXT[Claude Code / Codex / OpenCode / User Pi]
        ENV[Local Projects / Tools / Shell]
        CT[Optional Cortana / Local Context Provider]
    end
    subgraph Hosted["User-Controlled Self-Hosted / VPS"]
        HCP[Self-Hosted Control Plane simple/server / Restate / SQLite or PostgreSQL]
        HRT[Remote Runtime Host]
        HPI[Managed Pi / ACP Harnesses]
        HCT[Optional Co-located Cortana / Context Provider]
    end
    D <--> APP
    W <--> APP
    M <--> APP
    APP <--> DB
    APP --> RELAY
    APP <--> META
    APP --> EVT
    LCP --> LG
    RELAY <--> LCP
    RELAY <--> HCP
    LCP -. non-co-located runtime only .-> RG
    HCP -. non-co-located runtime only .-> RG
    RG <--> RH
    HCP --> HRT
    HCP --> HCT
    HRT --> HPI
    LC <--> D
    D -->|Local direct| LCP
    LCP -->|DirectLocalRuntimeTransport| RH
    EVT --> D
    EVT --> W
    EVT --> M
    RH --> MPD
    MPD --> MPI
    RH --> ACPD
    ACPD --> EXT
    RH --> CPD
    CPD --> CT
    MPI --> ENV
    EXT --> ENV
```

## Consumer Managed-Cloud Execution Topology

```mermaid
flowchart LR
    C[Desktop / Web / Mobile] --> APP[Agent HQ Cloud Application Services]
    APP --> RELAY[Durable Remote Relay / HPKE]
    APP --> X{Execution Location}
    X -->|Local| RELAY
    RELAY --> LCP[Local Control Plane]
    X -->|Self-hosted| RELAY
    RELAY --> HCP[Self-Hosted Control Plane]
    X -->|Agent HQ Cloud| CCP[Agent HQ Cloud Control Plane]
    LCP --> L[Local RuntimeNode]
    HCP --> H[Self-Hosted RuntimeNode]
    CCP --> CC[Agent HQ Cloud RuntimeNode]
    L --> LH[Local Harnesses / Pi]
    H --> HH[Self-Hosted Harnesses / Pi]
    CC --> S[Isolated Managed Sandbox]
    S --> PI[Managed Pi]
    P[(Cloud-Safe Workspace / Product Metadata)] <--> APP
    LC[(Encrypted Local Private Content)] <--> C
    LPS[(Local ProjectState / Execution State)] <--> LCP
    HPS[(Self-Hosted ProjectState / Execution State)] <--> HCP
    CPS[(Managed-Cloud ProjectState / Execution State)] <--> CCP
    CC -. runtime state / artifacts as authorized .-> CPS
```

## Identity and Principal Mapping

```mermaid
flowchart LR
    AUTH[Neon Auth] --> AB[@agent-hq/auth]
    AB --> AI[(AuthIdentity)]
    AI --> U[(Stable Agent HQ User)]
    U --> UP[User PrincipalRef]
    UP --> MEM[Workspace Membership and Permissions]
    DS[Desktop App Session] --> UP
    RN[(RuntimeNode Registration)] --> DP[Device PrincipalRef]
    CP[Control Plane Service] --> SP[Service PrincipalRef]
    AG[Persistent Agent] --> AP[Agent PrincipalRef]
    WK[Worker] --> WP[Worker PrincipalRef]
    DP -. separate credential lifecycle .- DS
    SP -. separate credential lifecycle .- UP
```

## Desktop Authentication Boundary

```mermaid
sequenceDiagram
    actor U as User
    participant D as Packaged Tauri Desktop
    participant B as System Browser
    participant A as Agent HQ Auth Broker
    participant N as Neon Auth
    U->>D: Sign in
    D->>D: Create state, nonce, PKCE verifier
    D->>B: Open authorization URL
    B->>N: Authenticate user
    N-->>A: Provider callback
    A-->>B: One-time desktop callback code
    B->>D: Deep link or secure loopback callback
    D->>A: Exchange code plus PKCE verifier
    A-->>D: Desktop application session
    Note over D,A: Browser cookies, RuntimeNode signing keys, and RuntimeNode E2E encryption keys are distinct credentials
```

## RuntimeNode Ownership and Command Channel

```mermaid
flowchart LR
    subgraph AgentHQ["Agent HQ Application Services"]
        RN[(RuntimeNode Registry)]
        PAIR[Pairing / Rotation / Revocation]
    end
    subgraph Control["Control Plane"]
        RC[(RuntimeConnection)]
        RA[RuntimeAdapter]
        PC[(ContextProviderConnection)]
        CA[ContextProviderAdapter]
    end
    subgraph Gateway["Runtime Infrastructure"]
        RG[Runtime Gateway - non-co-located RuntimeNode only]
    end
    subgraph Device["Paired Desktop RuntimeNode"]
        HOST[Local Runtime Host]
        DR[RuntimeDriver]
        MP[ManagedPiDriver]
        AD[ACPDriver]
        PI[Managed Local Pi]
        EXT[External Harness]
        CT[Optional Local Context Provider]
    end
    PAIR --> RN
    RC -->|attached to| RN
    RA --> RC
    RA --> DR
    RA -->|Remote RuntimeNode only| RG
    CA --> PC
    CA -->|Co-located provider| CT
    CA -->|Non-co-located provider| RP[Provider-Neutral Remote Transport]
    RP --> CT
    HOST <-->|Outbound authenticated WebSocket| RG
    HOST --> DR
    DR --> MP --> PI
    DR --> AD --> EXT
    PC -->|available through| RN
    RN -. Ed25519 auth identity / authorization .-> RG
    RN -. separate X25519 E2E content key registered with Agent HQ .-> PAIR
```

## Remote-Origin Cross-Service Command and Event Consistency

```mermaid
sequenceDiagram
    actor U as User
    participant A as Agent HQ API
    participant X as Agent HQ Remote Relay
    participant AD as Agent HQ Database
    participant P as Selected Control Plane Host
    participant CD as Control Plane Database
    participant G as DirectLocalRuntimeTransport or Runtime Gateway
    participant N as RuntimeNode
    participant E as Railway Event Gateway
    participant C as Client
    U->>A: Submit Task
    A->>AD: Transaction: cloud-safe Task metadata + CommandOutbox/ciphertext ref
    A->>X: Route request metadata + HPKE envelope
    X->>P: Deliver request_id/idempotency/payload_hash + ciphertext
    P->>P: Endpoint decrypt + scope/schema validation
    P->>CD: CommandInbox dedupe plus logical Execution and ExecutionPlan
    P->>CD: Restate workflow / invocation reference
    P->>G: Expiring command_id over selected local/remote transport
    G->>N: At-least-once RuntimeCommand
    N-->>G: Ack, progress, result, or reconciliation_required
    G-->>P: Correlated runtime messages
    P-->>A: Versioned Control Plane events
    A->>AD: EventInbox plus product state plus WorkspaceEvent
    AD-->>E: Advisory wake-up identifier
    E-->>C: SSE replay and live WorkspaceEvents
    Note over P,N: Remote-origin example; local desktop may submit the same versioned/idempotent contract directly to local Control Plane. Ambiguous non-idempotent external effects are not retried automatically
```

## LocalProjectGrant and Context Promotion

```mermaid
flowchart LR
    U([User]) --> G[Approve LocalProjectGrant]
    G --> CM[(Cloud Grant Metadata)]
    G --> NM[(Encrypted Node-Local Root Mapping)]
    CP[Control Plane Context Builder] --> R[Bounded LocalContextRequest]
    R --> CM
    R --> NM
    NM --> B[Excerpts / Hashes / Index / Local Artifact References]
    B --> C[ContextPackage]
    B --> D{Promote durable output?}
    D -->|ProjectState| P[StatePromotionProposal]
    D -->|Cloud Artifact| A[Artifact Upload Intent]
    D -->|No| L[Remain Local]
    A --> V[Agent HQ Cloudflare R2 via @agent-hq/artifacts]
    Note[Absolute paths never enter cloud product state]
    NM -. enforces .-> Note
```

## Artifact Storage and Lifecycle

```mermaid
flowchart LR
    U[User Upload] --> P[Pending Artifact Metadata]
    R[Runtime Output] --> P
    X[External System] --> ER[External Reference]
    P --> D{Byte Location}
    D --> L[Local RuntimeNode]
    D --> C[Agent HQ Cloudflare R2 - explicit cloud promotion]
    D --> ER
    L -->|Explicit authorized promotion| C
    C --> V[Verify Ownership / Size / Digest / Media Type]
    V --> S{MalwareScanner / ClamAV + File-Class Policy}
    S -->|Pass| A[Available]
    S -->|Block| Q[Quarantined]
    S -->|Failure| F[Failed]
    A --> DL[Short-Lived Authorized Read]
    A --> RET[Retention and Deletion Job]
    RET --> DEL[Deleted Tombstone]
    META[(Stable Artifact ID and Metadata)] --> P
    META --> ER
    META --> A
```

## Event Gateway Horizontal Scale and Replay

```mermaid
flowchart TB
    DB[(Agent HQ Neon WorkspaceEvent Log - >=30d online replay)]
    W[LISTEN/NOTIFY IDs + 2s Neon Poll Fallback]
    G1[Railway Event Gateway A]
    G2[Railway Event Gateway B]
    C1[Desktop or Web Client]
    C2[Another Client]
    DB --> G1
    DB --> G2
    DB -. event identifiers only .-> W
    W -. wake .-> G1
    W -. wake .-> G2
    C1 -->|HMAC-authenticated opaque cursor| G1
    C2 -->|HMAC-authenticated opaque cursor| G2
    G1 -->|Replay then live SSE| C1
    G2 -->|Replay then live SSE| C2
    G1 -. any instance can recover .-> DB
    G2 -. any instance can recover .-> DB
    DB --> R[Current-State Resync when Cursor Is Outside Retention]
```
