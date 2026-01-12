
import { createClient } from '@supabase/supabase-js';

/**
 * Connected to Supabase Project: bwxroouqhzymxfcjvdve
 */
const supabaseUrl = 'https://bwxroouqhzymxfcjvdve.supabase.co';
const supabaseKey = 'sb_publishable_qUXK2LZ0RLHZbuz4tCluTA_6cUKxP2n';

export const supabase = createClient(supabaseUrl, supabaseKey);
