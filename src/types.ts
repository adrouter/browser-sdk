import type {
  TurnEvent, TurnStatus, SponsorOffer, PublicMessage, UsageSummary,
  FeedbackInput, FeedbackAcknowledgement, ExistingTurn, RenderFailure,
  ErrorCode
} from "./generated/wire.js";

export type {
  TurnEvent, TurnStatus, SponsorOffer, PublicMessage, UsageSummary
} from "./generated/wire.js";

export interface SDKError {
  code: ErrorCode | 'unknown_persona';
  message: string;
  turnId?: string;
}
export interface Endpoints {
  chat: string;
  status: (turnId: string) => string;
  cancel: (turnId: string) => string;
  feedback: string;
  clientEvents: string;
  measurement: string;
}
export interface ClientOptions {
  persona?:string;
  history?:import('./history.js').HistoryLimits;
  onHistoryTrimmed?:(event:import('./history.js').HistoryTrimmed)=>void;
  endpoints: Endpoints;
  getTurnstileToken: () => Promise<string>;
  fetch?: typeof fetch; // Dependency injection for tests.
  onStarted?: (turnId: string) => void;
  onModelDelta?: (text: string, turnId: string) => void;
  onSponsorOffer?: (offer: SponsorOffer, turnId: string) => void;
  onSponsorNone?: (reason: string, turnId: string) => void;
  onUsage?: (usage: UsageSummary, turnId: string) => void;
  onCompleted?: (status: TurnStatus) => void;
  onError?: (error: SDKError) => void;
  onEvent?: (event: TurnEvent) => void;
}
export interface SendTurnOptions {
  messages: PublicMessage[];
  sponsorshipEnabled?: boolean;
}
export interface TurnResult {
  kind: "new" | "existing";
  delivery: "complete" | "interrupted";
  status: TurnStatus;
}
export interface TurnHandle {
  readonly operationId: string; // Generated once before any network request.
  readonly interactionId: string;
  readonly turnId: string | undefined;
  readonly done: Promise<TurnResult>;
  cancel(): Promise<void>;
}
export interface PlacementBindings {
  demoDisclosure?:HTMLElement;
  root: HTMLElement;
  disclosure: HTMLElement;
  advertiser: HTMLElement;
  content: HTMLElement;
  destination: HTMLAnchorElement;
}
export interface PlacementState {
  rendered: boolean;
  measurable: boolean;
  visibilityReported: boolean;
  qualification: "unknown" | "qualified_test_view" | "not_qualified";
  failure: RenderFailure | null;
}
export interface PlacementHandle {
  readonly state: PlacementState;
  check(): PlacementState;
  dismiss(): void;
  dispose(): void;
}
export interface AdRouterClient {
  sendTurn(options: SendTurnOptions): TurnHandle;
  getTurnStatus(turnId: string): Promise<TurnStatus>;
  submitFeedback(
    input: Omit<FeedbackInput, "contract_version" | "feedback_id">
  ): Promise<FeedbackAcknowledgement>;
  registerPlacement(options: {
    offer: SponsorOffer;
    bindings: PlacementBindings;
    onState?: (state: PlacementState) => void;
  }): PlacementHandle;
  dispose(): void;
}
export declare function createAdRouterClient(options: ClientOptions): AdRouterClient;
export declare function renderSponsorCard(options: {
  client: AdRouterClient;
  offer: SponsorOffer;
  container: HTMLElement;
  onState?: (state: PlacementState) => void;
}): PlacementHandle;
export type DuplicateStartResponse = ExistingTurn;
