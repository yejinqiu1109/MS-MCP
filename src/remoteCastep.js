function perlLiteral(value) {
  return `"${String(value)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\$/g, "\\$")
    .replace(/@/g, "\\@")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")}"`;
}

function settingsToPerl(settings) {
  return Object.entries(settings)
    .map(([key, value]) => {
      const encoded = typeof value === "number"
        ? String(value)
        : typeof value === "boolean"
          ? perlLiteral(value ? "Yes" : "No")
          : perlLiteral(value);
      return `${perlLiteral(key)} => ${encoded}`;
    })
    .join(",\n            ");
}

function convergenceParserPerl() {
  return String.raw`
sub write_castep_convergence_csvs {
    my ($calc) = @_;
    my @candidates = ("$calc/$calc.castep", "$calc/$calc.txt");
    my $source_path = "";
    for my $candidate (@candidates) {
        if (-f $candidate && -s $candidate) {
            $source_path = $candidate;
            last;
        }
    }
    die "CASTEP convergence source not found for $calc" unless $source_path;

    open(my $input_fh, "<", $source_path)
        or die "Cannot open CASTEP convergence source $source_path: $!";
    open(my $scf_fh, ">", "$calc/" . $calc . "_scf_convergence.csv")
        or die "Cannot create SCF convergence CSV for $calc: $!";
    open(my $geom_fh, ">", "$calc/" . $calc . "_geometry_convergence.csv")
        or die "Cannot create geometry convergence CSV for $calc: $!";

    csv_row($scf_fh, qw(SCFBlock SCFCycle Label Energy_eV FermiEnergy_eV EnergyGainPerAtom_eV Timer_s));
    csv_row($geom_fh, qw(GeometryIteration Enthalpy_eV EnergyChangePerIon_eV MaxForce_eV_per_A MaxDisplacement_A EnergyOK ForceOK DisplacementOK));

    my $scf_block = 0;
    my $in_scf = 0;
    my $scf_rows = 0;
    my %geometry;

    while (my $line = <$input_fh>) {
        if ($line =~ /SCF loop\s+Energy.*<--\s*SCF/i) {
            $scf_block += 1;
            $in_scf = 1;
            next;
        }
        if ($in_scf && $line =~ /^\s*Initial\s+([+\-0-9.EeDd]+)\s+([+\-0-9.EeDd]+)\s+([+\-0-9.EeDd]+)?\s*<--\s*SCF/i) {
            csv_row($scf_fh, $scf_block, 0, "Initial", $1, $2, "", defined($3) ? $3 : "");
            $scf_rows += 1;
            next;
        }
        if ($in_scf && $line =~ /^\s*(\d+)\s+([+\-0-9.EeDd]+)\s+([+\-0-9.EeDd]+)\s+([+\-0-9.EeDd]+)\s+([+\-0-9.EeDd]+)\s*<--\s*SCF/i) {
            csv_row($scf_fh, $scf_block, $1, "Iteration", $2, $3, $4, $5);
            $scf_rows += 1;
            next;
        }
        if ($line =~ /^\s*Final energy,\s*E\s*=\s*([+\-0-9.EeDd]+)/i) {
            $in_scf = 0;
            next;
        }
        if ($line =~ /(?:LBFGS|BFGS):\s*finished iteration\s+(\d+)\s+with enthalpy=\s*([+\-0-9.EeDd]+)/i) {
            $geometry{$1}{enthalpy} = $2;
            next;
        }
        if ($line =~ /\|\s*dE\/ion\s*\|\s*([+\-0-9.EeDd]+)\s*\|[^|]*\|[^|]*\|\s*(Yes|No)\s*\|/i) {
            my $iteration = (sort { $b <=> $a } keys %geometry)[0];
            if (defined $iteration) {
                $geometry{$iteration}{de} = $1;
                $geometry{$iteration}{energy_ok} = $2;
            }
            next;
        }
        if ($line =~ /\|\s*\|F\|max\s*\|\s*([+\-0-9.EeDd]+)\s*\|[^|]*\|[^|]*\|\s*(Yes|No)\s*\|/i) {
            my $iteration = (sort { $b <=> $a } keys %geometry)[0];
            if (defined $iteration) {
                $geometry{$iteration}{force} = $1;
                $geometry{$iteration}{force_ok} = $2;
            }
            next;
        }
        if ($line =~ /\|\s*\|dR\|max\s*\|\s*([+\-0-9.EeDd]+)\s*\|[^|]*\|[^|]*\|\s*(Yes|No)\s*\|/i) {
            my $iteration = (sort { $b <=> $a } keys %geometry)[0];
            if (defined $iteration) {
                $geometry{$iteration}{displacement} = $1;
                $geometry{$iteration}{displacement_ok} = $2;
            }
            next;
        }
    }

    my $geom_rows = 0;
    for my $iteration (sort { $a <=> $b } keys %geometry) {
        my $row = $geometry{$iteration};
        csv_row(
            $geom_fh,
            $iteration,
            $row->{enthalpy} // "",
            $row->{de} // "",
            $row->{force} // "",
            $row->{displacement} // "",
            $row->{energy_ok} // "",
            $row->{force_ok} // "",
            $row->{displacement_ok} // "",
        );
        $geom_rows += 1;
    }

    close($input_fh);
    close($scf_fh);
    close($geom_fh);
    return "generated:scf=$scf_rows;geometry=$geom_rows;source=$source_path";
}
`;
}

export const legacyCarbonCastepSettings = Object.freeze({
  XCFunctional: "PBE",
  Pseudopotentials: "OTFG ultrasoft",
  UseDFTD: "Yes",
  DFTDMethod: "TS",
  UseCustomEnergyCutoff: "Yes",
  EnergyCutoff: 326.5,
  KPointDerivation: "Gamma",
  MaximumSCFCycles: 100,
  EnergyTolerancesScope: "Atom",
  SCFConvergence: 2.0e-6,
  DensityMixingScheme: "Pulay",
  Smearing: 0.1,
  CellOptimization: "None",
  OptimizationAlgorithm: "LBFGS",
  MaxIterations: 100,
  EnergyConvergence: 1.0e-5,
  ForceConvergence: 0.03,
  DisplacementConvergence: 1.0e-3,
  CalculateCharge: "Hirshfeld",
  CalculateSpin: "Hirshfeld",
});

function safeName(value, fallback = "job") {
  return String(value || fallback)
    .replace(/\.xsd$/i, "")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80) || fallback;
}

export function buildRemoteCastepBatchScript({ batchName, tasks, commonSettings = {}, cores = 48 }) {
  const safeBatch = safeName(batchName, "remote_castep_batch");
  const requestedCores = Math.max(1, Math.trunc(Number(cores) || 48));
  const taskBlocks = tasks.map((task) => {
    const sourceDocument = String(task.documentName);
    const calculationName = safeName(task.calculationName || `${sourceDocument}_spin${task.initialSpin}`);
    const spinSettings = task.initialSpin === null || task.initialSpin === undefined
      ? { SpinTreatment: "Non-polarized" }
      : {
          SpinTreatment: "Collinear",
          UseFormalSpin: "No",
          InitialSpin: Number(task.initialSpin),
          OptimizeTotalSpin: "Yes",
        };
    const settings = {
      ...legacyCarbonCastepSettings,
      ...commonSettings,
      ...spinSettings,
      ...(task.settings || {}),
    };
    const settingsText = settingsToPerl(settings);
    return `
{
    my $model = ${perlLiteral(sourceDocument)};
    my $calc = ${perlLiteral(calculationName)};
    my $initial_spin = ${task.initialSpin === null || task.initialSpin === undefined ? '""' : Number(task.initialSpin)};
    my $status = "failed";
    my $energy = "";
    my $final_moment = "";
    my $convergence_data_status = "not_generated";
    my $message = "";
    eval {
        my $source = $Documents{$model};
        die "Input document not found: $model" unless $source;
        my $work = $source->SaveAs("/$calc/$calc.xsd");
        my $settings = Settings(
            ${settingsText}
        );
        my $results = Modules->CASTEP->GeometryOptimization->Run($work, $settings);
        eval { $energy = $results->TotalEnergy; };
        eval { $final_moment = $results->TotalSpin; };
        eval {
            my $structure = $results->Structure;
            $structure->SaveAs("/$calc/${calculationName}_optimized.xsd") if $structure;
        };
        eval {
            my $report = $results->Report;
            $report->SaveAs("/$calc/${calculationName}.txt") if $report;
        };
        eval {
            $convergence_data_status = write_castep_convergence_csvs($calc);
        };
        if ($@) {
            my $convergence_error = $@;
            $convergence_error =~ s/[\r\n]+/ /g;
            $convergence_data_status = "failed: $convergence_error";
        }
        $status = "completed";
    };
    if ($@) {
        $message = $@;
        $message =~ s/[\r\n]+/ /g;
    }
    csv_row($summary_fh, $model, ${perlLiteral(task.metal || "")}, $initial_spin,
            $energy, $final_moment, $status, $message, $calc, $convergence_data_status);
    $summary_fh->flush();
}
`;
  }).join("\n");

  return `#!perl
use strict;
use warnings;
use IO::Handle;
use MaterialsScript qw(:all);
$ENV{DSD_NumProc} = ${requestedCores};

sub csv_escape {
    my ($value) = @_;
    $value = "" unless defined $value;
    $value =~ s/"/""/g;
    return '"' . $value . '"';
}

sub csv_row {
    my ($fh, @values) = @_;
    print $fh join(",", map { csv_escape($_) } @values) . "\\n";
}

${convergenceParserPerl()}

open(my $summary_fh, ">", "${safeBatch}_results.csv")
    or die "Cannot create batch result CSV: $!";
csv_row($summary_fh, qw(Model Metal InitialSpin FinalTotalEnergy FinalMoment ConvergenceStatus Message CalculationName ConvergenceDataStatus));
$summary_fh->autoflush(1);

${taskBlocks}

close($summary_fh);
print "Remote CASTEP batch ${safeBatch} finished.\\n";
`;
}

export function normalizeRemoteCastepTasks(tasks) {
  const seen = new Set();
  return tasks.map((task, index) => {
    const documentName = String(task.documentName || "").trim();
    if (!documentName) throw new Error(`Task ${index + 1} is missing documentName.`);
    const initialSpin = task.initialSpin === null || task.initialSpin === undefined
      ? null
      : Number(task.initialSpin);
    if (initialSpin !== null && !Number.isFinite(initialSpin)) {
      throw new Error(`Task ${index + 1} has an invalid initialSpin.`);
    }
    const calculationName = safeName(task.calculationName || `${documentName}_spin${initialSpin ?? "NP"}`);
    if (seen.has(calculationName.toLowerCase())) {
      throw new Error(`Duplicate calculationName: ${calculationName}`);
    }
    seen.add(calculationName.toLowerCase());
    return {
      documentName,
      calculationName,
      initialSpin,
      metal: task.metal ? String(task.metal) : "",
      settings: task.settings || {},
    };
  });
}
