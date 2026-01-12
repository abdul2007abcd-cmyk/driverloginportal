
export type TripStatus = 'pending' | 'started' | 'ended';

export interface Trip {
  otp: string;
  status: TripStatus;
  driver_id: string;
  start_time: string | null; // ISO Timestamp string
  end_time: string | null;   // ISO Timestamp string
  amount: number | null;
}

export interface AppState {
  activeTrip: Trip | null;
  loading: boolean;
  error: string | null;
  driverId: string;
}
