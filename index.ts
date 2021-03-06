import {exec} from 'child_process';
const dayjs = require("dayjs");
const core = require('@actions/core');
const Github = require('@actions/github');
const semver = require('semver')
const fs = require('fs');

type BranchType = {
    pattern: RegExp,
    bump: 'patch' | 'minor' | 'major' | 'chore',
    label: string
}
const branchTypes: Array<BranchType> = [
    {pattern: /^fix\/.*/, bump: "patch", label: "fix"},
    {pattern: /^feature\/.*/, bump: "minor", label: "feature"},
    {pattern: /^release\/.*/, bump: "major", label: "release"},
    {pattern: /^chore\/.*/, bump: "chore", label: "chore"},
]

const token = process.env['GITHUB_TOKEN']
const octokit = new Github.GitHub(token);
const {owner, repo} = Github.context.repo

// most @actions toolkit packages have async methods
async function run() {
    try {
        let pr: WebhookPayloadPullRequestPullRequest = null

        // Extract from comment event
        if (Github.context.eventName === 'issue_comment') {
            const issuePayload = Github.context.payload
            if (issuePayload.action === 'created' && issuePayload.comment.body.includes('#tag')) {
                const resp = await octokit.pulls.get({
                    owner,
                    repo,
                    pull_number: issuePayload.issue.number,
                })
                pr = resp.data
            }
        }
        // Extract from pull_request event
        if (Github.context.eventName === 'pull_request') {
            const prPayload = Github.context.payload as WebhookPayloadPullRequest
            // Opened:
            if (prPayload.action === 'opened') {
                await addLabel(prPayload.pull_request)
                const params = {
                    repo,
                    issue_number: prPayload.number,
                    owner,
                    body: `Add a comment including \`#tag\` to create a release candidate tag.`
                };
                await octokit.issues.createComment(params);
                return
            }
            // Continue only when PR is closed and merged:
            if (!(prPayload.action === 'closed' && prPayload.pull_request.merged)) {
                return
            }
            pr = prPayload.pull_request
        }
        // Additional validations
        if (!pr) {
            core.warning('PR not found')
            return
        }
        if (pr.base.ref !== 'master' && pr.base.ref !== 'main') {
            core.info('PR not to master, skipping')
            return
        }
        if (pr.draft) {
            core.info('PR is a draft, skipping')
            return
        }

        const preRelease = !pr.merged
        const branch = pr.head.ref
        const prNumber = pr.number

        // Define tag and release name
        const prefix = preRelease ? 'pre' : ''
        const pattern = branchTypes.find(branchPat => branchPat.pattern.test(branch))
        // Branch name validation:
        if (!pattern) {
            core.warning('branch pattern not expected, skipping')
            return
        }
        if(pattern.bump == 'chore'){
            return
        }

        // Get existing tags
        const tags = await octokit.repos.listTags({
            owner,
            repo,
            per_page: 100
        });
        let newTag = ""
        core.info('tags:')
        core.info(tags.data.map(tag => tag.name))
        // Find last valid tag (not RC)
        const fullReleases = tags.data.filter(tag => !semver.prerelease(tag.name) && semver.valid(tag.name) === tag.name)
        const firstValid = fullReleases.find(tag => semver.valid(tag.name))
        core.info(`firstValid: ${firstValid && firstValid.name}`)
        let lastTag = firstValid ? firstValid.name : '0.0.0'
        const bump = `${prefix}${pattern.bump}`
        if (preRelease) {
            const rcName = `rc-${branch.replace('/', '-')}`
            const rcs = tags.data.filter(tag => tag.name.includes(rcName))
            if (rcs.length !== 0) {
                // increase RC number
                newTag = semver.inc(rcs[0].name, 'prerelease')
            } else {
                // create RC
                newTag = semver.inc(lastTag, bump, rcName)
            }
        } else {
            newTag = semver.inc(lastTag, bump)
        }
        core.info(`newTag: ${newTag}`)
        // Create release
        const createReleaseResponse = await octokit.repos.createRelease({
            owner,
            repo,
            tag_name: newTag,
            name: pr.title,
            body: pr.body,
            draft: false,
            prerelease: preRelease,
            target_commitish: preRelease ? pr.head.ref : pr.base.ref
        });
        if (createReleaseResponse.status !== 201 && prNumber > 0) {
            core.setFailed('Failed to create release');
            return
        }

        core.setOutput("new_tag", newTag);
        core.setOutput("pre_release", preRelease);

        const params = {
            repo,
            issue_number: prNumber,
            owner,
            body: `:label: ${preRelease ? 'Pre-release' : 'Release'} \`${newTag}\` created.`
        };
        const new_comment = await octokit.issues.createComment(params);
    } catch (error) {
        core.setFailed(error.message);
    }
}

async function addLabel(pr: WebhookPayloadPullRequestPullRequest) {
    const pattern = branchTypes.find(branchPat => branchPat.pattern.test(pr.head.ref))
    // Branch name validation:
    if (!pattern) {
        core.warning('branch pattern not expected, skipping')
        return
    }
    await octokit.issues.addLabels({
        repo,
        owner,
        issue_number: pr.number,
        labels: [pattern.label]
    })
}

async function sh(cmd) {
    return new Promise(function (resolve, reject) {
        exec(cmd, (err, stdout, stderr) => {
            if (err) {
                reject(err);
            } else {
                resolve({stdout, stderr});
            }
        });
    });
}

function updateFile(file: string, update: (string) => string) {
    if (!fs.existsSync(file)) {
        fs.writeFileSync(file, `# Changelog
All notable changes to this project will be documented in this file.
`, 'utf-8')
    }
    const data = fs.readFileSync(file, 'utf-8')
    const newData = update(data)
    fs.writeFileSync(file, newData, 'utf-8')
}

run()

type WebhookPayloadPullRequestPullRequest = {
    url: string;
    id: number;
    node_id: string;
    html_url: string;
    diff_url: string;
    patch_url: string;
    issue_url: string;
    number: number;
    state: string;
    locked: boolean;
    title: string;
    body: string;
    created_at: string;
    updated_at: string;
    closed_at: null | string;
    merged_at: null;
    merge_commit_sha: null | string;
    requested_reviewers: Array<any>;
    requested_teams: Array<any>;
    commits_url: string;
    review_comments_url: string;
    review_comment_url: string;
    comments_url: string;
    statuses_url: string;
    head: WebhookPayloadPullRequestPullRequestHead;
    base: WebhookPayloadPullRequestPullRequestBase;
    author_association: string;
    draft: boolean;
    merged: boolean;
    mergeable: null | boolean;
    rebaseable: null | boolean;
    mergeable_state: string;
    merged_by: null;
    comments: number;
    review_comments: number;
    maintainer_can_modify: boolean;
    commits: number;
    additions: number;
    deletions: number;
    changed_files: number;
};
type WebhookPayloadPullRequestPullRequestBase = {
    label: string;
    ref: string;
    sha: string;
};
type WebhookPayloadPullRequestPullRequestHead = {
    label: string;
    ref: string;
    sha: string;
};
type WebhookPayloadPullRequest = {
    action: string;
    number: number;
    pull_request: WebhookPayloadPullRequestPullRequest;
};