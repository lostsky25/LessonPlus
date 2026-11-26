export interface SubscriptionActivation {
  eventId: string;
  subscriptionId: string;
  studentId: string;
}

export interface SubscriptionActivationStore {
  record(activation: SubscriptionActivation): Promise<void>;
}
