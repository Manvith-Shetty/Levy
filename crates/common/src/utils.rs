use std::str::FromStr;

pub fn get_from_env_unsafe<F>(name: &str) -> Result<F, String>
where
    F: FromStr,
    <F as FromStr>::Err: std::fmt::Debug,
{
    let var = std::env::var(name).map_err(|e| {
        tracing::info!("{name} env not found with error: {e}");
        format!("{name} env not found with error: {e}")
    })?;

    var.parse().map_err(|e| {
        tracing::info!("{name} failed to parse env value to expected type: {e:?}");
        format!("{name} failed to parse env value to expected type: {e:?}")
    })
}
