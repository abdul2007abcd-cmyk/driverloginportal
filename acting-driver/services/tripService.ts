
import { supabase } from '../supabaseClient';
import { Trip, TripStatus } from '../types';

/**
 * REQUIRED SUPABASE TABLE SCHEMA:
 * table: trips
 * - otp: text (primary key)
 * - status: text (check: pending, started, ended)
 * - driver_id: text
 * - start_time: timestamptz
 * - end_time: timestamptz
 * - amount: numeric
 */

const RATE_PER_HOUR = 150;
const MIN_HOURS = 4;

export const verifyOtpAndStartTrip = async (otp: string, driverId: string): Promise<Trip> => {
  const { data, error } = await supabase
    .from('trips')
    .update({
      status: 'started' as TripStatus,
      driver_id: driverId,
      start_time: new Date().toISOString(),
    })
    .match({ otp: otp, status: 'pending' })
    .select()
    .single();

  if (error) {
    if (error.code === 'PGRST116') {
      throw new Error("Invalid OTP or Trip already in progress/finished.");
    }
    throw new Error(error.message);
  }

  return data as Trip;
};

export const stopTripAndCalculateAmount = async (otp: string): Promise<Trip> => {
  const { data: trip, error: fetchError } = await supabase
    .from('trips')
    .select('*')
    .eq('otp', otp)
    .single();

  if (fetchError || !trip) throw new Error("Trip data not found.");
  if (trip.status !== 'started' || !trip.start_time) {
    throw new Error("Cannot end a trip that hasn't started.");
  }

  const start = new Date(trip.start_time);
  const end = new Date();
  const diffHours = (end.getTime() - start.getTime()) / (1000 * 60 * 60);
  
  // Logic: Max of 4 hours, multiplied by hourly rate
  const billableHours = Math.max(MIN_HOURS, diffHours);
  const finalAmount = Math.round(billableHours * RATE_PER_HOUR);

  const { data, error: updateError } = await supabase
    .from('trips')
    .update({
      status: 'ended' as TripStatus,
      end_time: end.toISOString(),
      amount: finalAmount
    })
    .eq('otp', otp)
    .select()
    .single();

  if (updateError) throw new Error(updateError.message);
  return data as Trip;
};

export const fetchTripDetails = async (otp: string): Promise<Trip | null> => {
  const { data, error } = await supabase
    .from('trips')
    .select('*')
    .eq('otp', otp)
    .maybeSingle();

  if (error) return null;
  return data as Trip;
};
