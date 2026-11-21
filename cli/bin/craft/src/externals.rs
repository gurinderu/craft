//! Raw compatibility entry for the package adapter (realm @nick/craft, #573).
use craft_review::externals::{self, Error, Invocation};
use craft_store::js::{self, Js, Obj};
use std::io::{Read, Write};
use std::process::ExitCode;

#[derive(Debug, clap::Args)]
#[command(disable_help_flag = true, disable_version_flag = true)]
pub struct Args {
    #[arg(trailing_var_arg = true, allow_hyphen_values = true, num_args = 0..)]
    pub argv: Vec<String>,
}

fn answer(args: &Args) -> Result<Js, Error> {
    let invocation = Invocation::parse(&args.argv)?;
    let mut bytes = Vec::new();
    let input = if invocation.memory || invocation.known {
        std::io::stdin().read_to_end(&mut bytes)?;
        js::parse(&String::from_utf8_lossy(&bytes)).ok()
    } else {
        Some(Js::Arr(Vec::new()))
    };
    let why = if invocation.memory {
        "stdin is not JSON of a list of records"
    } else {
        "--known -: stdin is not JSON of a list of records"
    };
    let input = input.ok_or_else(|| Error::Refused(why.into()))?;
    if invocation.memory {
        return externals::import(&invocation.root, &input);
    }
    let known = externals::record_list(&input).ok_or_else(|| Error::Refused(why.into()))?;
    externals::discover(&invocation.root, invocation.paths.as_deref(), known)
}

pub fn run(args: &Args) -> anyhow::Result<ExitCode> {
    let (code, output) = match answer(args) {
        Ok(value) => (ExitCode::SUCCESS, value),
        Err(e) => (
            ExitCode::FAILURE,
            Js::Obj(Obj::new().with("error", Js::str(e.message()))),
        ),
    };
    writeln!(std::io::stdout().lock(), "{}", output.compact())?;
    Ok(code)
}
