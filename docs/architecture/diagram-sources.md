# Agent HQ Diagram Sources

Status: Canonical repository source
Owner: Agent HQ architecture
Last reviewed: 2026-08-23

These Mermaid definitions are the version-controlled source for the rendered diagrams in the canonical Google Docs.

## Editing and rendering rules

1. Edit the Mermaid definition here first.
2. Render and inspect the diagram before replacing the image in its owning document.
3. Keep the heading aligned with the owning Google Doc and figure purpose.
4. Do not hand-edit rendered diagram images.
5. Cross-repository definitions owned by the Control Plane remain in that repository's companion diagram-source file.

## Agent HQ PRD: Product Architecture

```mermaid
flowchart LR
    U([User]) --> HQ[Agent HQ Workspace]
    HQ --> CP[Control Plane]
    CP --> EP[Immutable ExecutionPlan]
    EP --> TW[Temporal]
    TW --> D{Graph semantics required?}
    D -->|No| RA[Runtime Adapter]
    D -->|Yes| LG[LangGraph.js]
    LG --> RA
    RA --> RG[Runtime Gateway when local]
    RG --> RD[RuntimeDriver]
    RD --> MP[Managed Pi]
    RD --> ACP[ACP External Harness]
    MP --> MT[Models / Tools / Sandbox]
    ACP --> MT
    MT --> EV[Normalized Control Plane Events]
    EV --> EI[Agent HQ EventInbox]
    EI --> WE[WorkspaceEvent]
    WE --> EG[Event Gateway / SSE]
    EG --> HQ
```

## System Architecture Overview

```mermaid
flowchart TB
    subgraph Product["Agent HQ Product"]
        C[Next.js / React Client]
        A[Application Services]
        AD[(Agent HQ PostgreSQL / Drizzle)]
        AUTH[Neon Auth via @agent-hq/auth]
        EG[Event Gateway / Durable SSE]
        AB[Agent HQ Artifacts / Vercel Private Blob]
    end
    subgraph Control["Control Plane"]
        CP[Profiles / Context / Routing / Policy]
        EP[Immutable ExecutionPlan]
        PS[(ProjectState)]
        CD[(Control Plane PostgreSQL / Drizzle)]
        TW[Temporal Durable Lifecycle]
        LG[LangGraph.js Bounded Graph Segments]
        RA[Runtime Adapters]
        TG[Tool Gateway / MCP]
        MG[Model Gateway]
        SB[SandboxProvider]
    end
    subgraph Runtime["Runtime Infrastructure & Local Runtimes"]
        RG[Runtime Gateway]
        DR[Desktop RuntimeDrivers]
        PI[Managed Local Pi]
        ACP[External Harnesses via ACP]
    end
    C --> AUTH --> A
    C --> A
    A --> AD
    A --> EG --> C
    A --> AB
    A --> CP
    CP --> EP
    CP <--> PS
    CP --> CD
    EP --> TW
    TW --> LG
    LG --> RA
    RA --> TG
    RA --> MG
    RA --> SB
    RA --> RG
    RG --> DR
    DR --> PI
    DR --> ACP
    PI --> RA
    ACP --> RA
    RA --> CP
    CP --> A
```

## Agent HQ TDD: Application Architecture

```mermaid
flowchart TB
    U([User]) --> CL[Agent HQ Desktop Client]
    subgraph Client["Client Layer"]
        CL --> UI[React / shadcn UI]
        CL --> SR[Vanilla Three.js Scene Runtime]
        CL --> Q[TanStack Query]
        CL --> Z[Zustand Transient State]
    end
    subgraph AgentHQ["Agent HQ Cloud Application"]
        API[Application Services / API]
        DB[(Agent HQ PostgreSQL / Drizzle)]
        EVT[WorkspaceEvent Log]
        EG[Event Gateway / SSE]
        ART[Artifact Metadata / @agent-hq/artifacts]
    end
    subgraph Control["Control Plane"]
        CP[Control Plane SDK / Service Boundary]
    end
    UI --> Q
    SR --> Q
    Q <--> API
    API <--> DB
    API --> EVT
    EVT --> EG --> Q
    API --> ART
    API <--> CP
```

## Agent HQ TDD: Real-Time Event Flow

```mermaid
sequenceDiagram
    actor U as User
    participant C as Agent HQ Client Surface
    participant A as Agent HQ API
    participant P as Control Plane
    participant T as Temporal
    participant RA as Runtime Adapter
    participant G as Runtime Gateway / Runtime Path
    participant R as Runtime
    participant E as Event Service
    participant D as Event Store
    U->>C: User action
    C->>A: Semantic command
    A->>P: Execution request
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
        DB[(Agent HQ PostgreSQL / Drizzle)]
        EG[Event Gateway]
        ART[@agent-hq/artifacts]
        BLOB[(Vercel Private Blob)]
    end
    subgraph ControlCloud["Control Plane Trust Zone"]
        CP[Control Plane]
        CDB[(Control Plane PostgreSQL / Drizzle)]
        SEC[(KMS / Secrets / Credential Leases)]
        RG[Runtime Gateway]
        TG[Tool Gateway / PolicyDecisionPoint]
        MG[Model Gateway]
        SB[SandboxProvider]
    end
    subgraph Local["User Device Trust Zone"]
        RH[Desktop Local Runtime Host]
        MP[Managed Local Pi]
        EH[External Harnesses]
    end
    subgraph External["External Provider / Connector Trust Zone"]
        PR[Models / Tools / Connectors / Sandbox Provider]
    end
    B --> AUTH
    AUTH --> API
    API --> DB
    API --> EG
    EG --> B
    API --> ART
    ART --> BLOB
    API --> CP
    CP --> CDB
    CP --> SEC
    CP --> RG
    CP --> TG
    CP --> MG
    CP --> SB
    RG <-->|Outbound authenticated runtime channel| RH
    RH --> MP
    RH --> EH
    MP --> PR
    EH --> PR
    TG --> PR
    MG --> PR
    SB --> PR
```

## Data Model & API: Domain Relationships

```mermaid
erDiagram
    USER ||--o{ MEMBERSHIP : has
    WORKSPACE ||--o{ MEMBERSHIP : contains
    WORKSPACE ||--o{ ROOM : contains
    WORKSPACE ||--o{ AGENT : contains
    WORKSPACE ||--o{ TASK : contains
    WORKSPACE ||--o{ CHANNEL : contains
    CHANNEL ||--o{ MESSAGE : contains
    AGENT ||--o{ TASK : assigned
    TASK ||--o{ EXECUTION_REF : references
    AGENT }o--|| AGENT_PROFILE_REF : uses
    WORKSPACE ||--o{ WORKSPACE_EVENT : emits
    WORKSPACE ||--o{ RUNTIME_CONNECTION_VIEW : surfaces
    RUNTIME_CONNECTION_VIEW ||--o{ EXTERNAL_SESSION_VIEW : exposes
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

## Desktop-First Runtime Topology

```mermaid
flowchart TB
    subgraph Clients["Agent HQ Clients"]
        D[Desktop App / Full Workspace]
        W[Web Remote Control]
        M[Mobile Remote Control]
    end
    subgraph Cloud["Cloud Coordination Services"]
        APP[Application Services]
        DB[(PostgreSQL / Drizzle)]
        CP[Control Plane]
        PS[(ProjectState)]
        TW[Temporal]
        LG[LangGraph.js]
        EVT[Sync / Events]
        RG[Runtime Gateway]
    end
    subgraph Local["Paired Developer Device"]
        RH[Local Runtime Host]
        MPI[Managed Local Pi]
        MPD[ManagedPiDriver]
        ACPD[ACPDriver]
        EXT[Claude Code / Codex / OpenCode / User Pi]
        ENV[Local Projects / Tools / Shell]
    end
    D <--> APP
    W <--> APP
    M <--> APP
    APP <--> DB
    APP --> CP
    CP <--> PS
    CP --> TW
    TW --> LG
    CP <--> RG
    RG <--> RH
    EVT --> D
    EVT --> W
    EVT --> M
    RH --> MPD
    MPD --> MPI
    RH --> ACPD
    ACPD --> EXT
    MPI --> ENV
    EXT --> ENV
```

## Later Cloud Workforce Topology

```mermaid
flowchart LR
    C[Desktop / Web / Mobile] --> APP[Agent HQ Cloud Application Services]
    APP --> CP[Control Plane]
    CP --> L[Local RuntimeNode]
    CP --> CC[Future Agent HQ Cloud RuntimeNode]
    L --> LH[Local Harnesses / Pi]
    CC --> S[Isolated Managed Sandbox]
    S --> PI[Managed Pi]
    P[(Persistent Workspace / Runtime State)] <--> APP
    CPS[(ProjectState / Execution State)] <--> CP
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
    Note over D,A: Browser cookies and RuntimeNode device credentials are never reused
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
    end
    subgraph Gateway["Runtime Infrastructure"]
        RG[Runtime Gateway]
    end
    subgraph Device["Paired Desktop RuntimeNode"]
        HOST[Local Runtime Host]
        DR[RuntimeDriver]
        MP[ManagedPiDriver]
        AD[ACPDriver]
        PI[Managed Local Pi]
        EXT[External Harness]
    end
    PAIR --> RN
    RC -->|attached to| RN
    RA --> RC
    RA --> RG
    HOST <-->|Outbound authenticated WebSocket| RG
    HOST --> DR
    DR --> MP --> PI
    DR --> AD --> EXT
    RN -. device identity and authorization .-> RG
```

## Cross-Service Command and Event Consistency

```mermaid
sequenceDiagram
    actor U as User
    participant A as Agent HQ API
    participant AD as Agent HQ Database
    participant P as Control Plane
    participant CD as Control Plane Database
    participant G as Runtime Gateway
    participant N as RuntimeNode
    participant E as Event Gateway
    participant C as Client
    U->>A: Submit Task
    A->>AD: Transaction: Task intent plus CommandOutbox
    A->>P: Deliver request_id, idempotency_key, payload_hash
    P->>CD: CommandInbox dedupe plus logical Execution and ExecutionPlan
    P->>CD: Temporal workflow reference
    P->>G: Expiring command_id
    G->>N: At-least-once RuntimeCommand
    N-->>G: Ack, progress, result, or reconciliation_required
    G-->>P: Correlated runtime messages
    P-->>A: Versioned Control Plane events
    A->>AD: EventInbox plus product state plus WorkspaceEvent
    AD-->>E: Advisory wake-up identifier
    E-->>C: SSE replay and live WorkspaceEvents
    Note over P,N: Ambiguous non-idempotent external effects are not retried automatically
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
    A --> V[Vercel Private Blob via @agent-hq/artifacts]
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
    D --> C[Vercel Private Blob]
    D --> ER
    L -->|Explicit authorized promotion| C
    C --> V[Verify Ownership / Size / Digest / Media Type]
    V --> S{Required Scan and Policy Check}
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
    DB[(PostgreSQL WorkspaceEvent Log)]
    W[LISTEN/NOTIFY or Advisory Wake-Up Bus]
    G1[Event Gateway A]
    G2[Event Gateway B]
    C1[Desktop or Web Client]
    C2[Another Client]
    DB --> G1
    DB --> G2
    DB -. event identifiers only .-> W
    W -. wake .-> G1
    W -. wake .-> G2
    C1 -->|Opaque workspace cursor| G1
    C2 -->|Opaque workspace cursor| G2
    G1 -->|Replay then live SSE| C1
    G2 -->|Replay then live SSE| C2
    G1 -. any instance can recover .-> DB
    G2 -. any instance can recover .-> DB
    DB --> R[Current-State Resync when Cursor Is Outside Retention]
```
