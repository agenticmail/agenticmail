/**
 * Setup Wizard — Step 3: Deployment Target
 *
 * Choose where the enterprise server will run.
 */

export type DeployTarget = 'cloud' | 'fly' | 'railway' | 'docker' | 'local';

export interface DeploymentSelection {
  target: DeployTarget;
}

export async function promptDeployment(
  inquirer: any,
  chalk: any,
): Promise<DeploymentSelection> {
  console.log('');
  console.log(chalk.bold.cyan('  Step 3 of 4: Deployment'));
  console.log(chalk.dim('  Where should your dashboard run?\n'));

  const { deployTarget } = await inquirer.prompt([{
    type: 'list',
    name: 'deployTarget',
    message: 'Deploy to:',
    choices: [
      {
        name: `AgenticMail Cloud  ${chalk.dim('(managed, instant URL)')}`,
        value: 'cloud',
      },
      {
        name: `Fly.io  ${chalk.dim('(your account)')}`,
        value: 'fly',
      },
      {
        name: `Railway  ${chalk.dim('(your account)')}`,
        value: 'railway',
      },
      {
        name: `Docker  ${chalk.dim('(self-hosted)')}`,
        value: 'docker',
      },
      {
        name: `Local  ${chalk.dim('(dev/testing, runs here)')}`,
        value: 'local',
      },
    ],
  }]);

  return { target: deployTarget };
}
