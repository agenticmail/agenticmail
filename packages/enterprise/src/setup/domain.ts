/**
 * Setup Wizard — Step 4: Custom Domain (Optional)
 *
 * Optionally configure a custom domain for the dashboard.
 */

export interface DomainSelection {
  customDomain?: string;
}

export async function promptDomain(
  inquirer: any,
  chalk: any,
  deployTarget: string,
): Promise<DomainSelection> {
  // Skip for local deployments
  if (deployTarget === 'local') {
    return {};
  }

  console.log('');
  console.log(chalk.bold.cyan('  Step 4 of 4: Custom Domain'));
  console.log(chalk.dim('  Optional — you can add this later.\n'));

  const { wantsDomain } = await inquirer.prompt([{
    type: 'confirm',
    name: 'wantsDomain',
    message: 'Add a custom domain?',
    default: false,
  }]);

  if (!wantsDomain) return {};

  const { domain } = await inquirer.prompt([{
    type: 'input',
    name: 'domain',
    message: 'Custom domain:',
    suffix: chalk.dim('  (e.g. agents.acme.com)'),
    validate: (v: string) => {
      if (!v.includes('.')) return 'Enter a valid domain (e.g. agents.acme.com)';
      return true;
    },
  }]);

  return { customDomain: domain };
}
