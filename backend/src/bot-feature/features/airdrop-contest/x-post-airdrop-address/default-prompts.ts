export const extractAddress = `
Here is a twitter post from user id '{authorId}'. If you consider that this post provides a blockchain address compatible with the {chain} blockchain, return the airdrop address and update the user/address map in database. Otherwise, return null.

Here is the tweet:
---------------- 
{tweetContent}
`