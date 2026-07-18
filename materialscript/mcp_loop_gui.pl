#!perl
use strict;
use warnings;
use MaterialsScript qw(:all);

# Run from the Materials Studio GUI:
# Tools/User -> Script Library -> User Menu -> Start MS-MCP Loop
# Run on = Client, Requires = Any document.

my $queue_root = $ENV{"MS_MCP_QUEUE_DIR"} || "D:\\CodexInstall\\MS-MCP-Workspace\\.mcp-queue";
my $sleep_seconds = $ENV{"MS_MCP_LOOP_SLEEP"} || 2;

my $pending = "$queue_root\\pending";
my $running = "$queue_root\\running";
my $done = "$queue_root\\done";
my $failed = "$queue_root\\failed";
my $held = "$queue_root\\held";
my $stop_file = "$queue_root\\stop";
my $workspace_root = $queue_root;
$workspace_root =~ s/[\\\/]\.mcp-queue$//;
my $session_file = "$workspace_root\\.ms-mcp-session.json";

sub current_project_root {
    my $root = $workspace_root;
    if (-e $session_file && open(my $session_fh, "<", $session_file)) {
        local $/;
        my $json = <$session_fh>;
        close($session_fh);
        if ($json =~ /"projectRoot"\s*:\s*"((?:\\.|[^"])*)"/) {
            $root = $1;
            $root =~ s/\\\\/\\/g;
            $root =~ s/\\"/"/g;
        }
    }
    mkdir $root unless -d $root;
    return $root;
}

my $started_marker = current_project_root() . "\\gui_loop_started.txt";
my $status_file = current_project_root() . "\\gui_loop_status.txt";

foreach my $dir ($queue_root, $pending, $running, $done, $failed, $held) {
    mkdir $dir unless -d $dir;
}

open(my $start_fh, ">>", $started_marker) or die "Cannot write $started_marker: $!";
print $start_fh "MS-MCP GUI loop started at " . scalar(localtime()) . "\n";
close($start_fh);

print "MS-MCP GUI loop started\n";
print "Queue: $queue_root\n";
print "This loop runs inside the GUI scripting context.\n";

sub write_status {
    my ($status, $job, $detail) = @_;
    $status_file = current_project_root() . "\\gui_loop_status.txt";
    open(my $sfh, ">>", $status_file) or return;
    print $sfh scalar(localtime()) . "\t$status\t" . ($job || "") . "\t" . ($detail || "") . "\n";
    close($sfh);
}

write_status("started", "mcp_loop_gui", $queue_root);
my $last_heartbeat = 0;

while (1) {
    last if -e $stop_file;
    my $now = time();
    if ($now - $last_heartbeat >= 30) {
        write_status("heartbeat", "mcp_loop_gui", $queue_root);
        $last_heartbeat = $now;
    }

    opendir(my $dh, $pending) or die "Cannot open $pending: $!";
    my @jobs = sort grep { /\.pl$/i && -f "$pending\\$_" } readdir($dh);
    closedir($dh);

    foreach my $job (@jobs) {
        my $src = "$pending\\$job";
        my $active = "$running\\$job";
        my $ok = "$done\\$job";
        my $bad = "$failed\\$job";

        next unless rename $src, $active;

        print "Running $job in GUI project\n";
        write_status("running", $job, "");

        my $success = eval {
            do $active;
            die $@ if $@;
            1;
        };

        if ($success) {
            rename $active, $ok;
            print "Finished $job\n";
            write_status("done", $job, "");
        } else {
            my $error = $@ || "Unknown MaterialsScript error";
            open(my $err_fh, ">", "$active.error.txt");
            print $err_fh $error;
            close($err_fh);
            rename $active, $bad;
            rename "$active.error.txt", "$bad.error.txt";
            print "Failed $job: $error\n";
            write_status("failed", $job, $error);
        }
    }

    sleep($sleep_seconds);
}

unlink $stop_file if -e $stop_file;
print "MS-MCP GUI loop stopped\n";
write_status("stopped", "mcp_loop_gui", "");

