-- Run only on the independently verified isolated recovery server as its owner.
-- Set the login password separately through a private credential channel.
CREATE ROLE cloudlib_recovery_worker LOGIN CREATEDB CREATEROLE NOSUPERUSER NOREPLICATION;
GRANT cloudlib_recovery_app TO cloudlib_recovery_worker WITH ADMIN TRUE;
GRANT pg_signal_backend TO cloudlib_recovery_worker;
GRANT EXECUTE ON FUNCTION pg_control_system() TO cloudlib_recovery_worker;
