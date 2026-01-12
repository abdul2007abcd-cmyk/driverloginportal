
import { supabase } from '../supabaseClient';
import { Trip } from '../types';

export const fetchAllTrips = async (): Promise<Trip[]> => {
  const { data, error } = await supabase
    .from('trips')
    .select('*')
    .order('start_time', { ascending: false });

  if (error) throw error;
  return data || [];
};

export const deleteTrip = async (otp: string): Promise<void> => {
  const { error } = await supabase
    .from('trips')
    .delete()
    .eq('otp', otp);

  if (error) throw error;
};
